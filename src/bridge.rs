use actix::prelude::*;
use actix::{Actor, StreamHandler};
use actix_web_actors::ws::{Message, ProtocolError, WebsocketContext};
use bytes::Bytes;
use serialport::{self, SerialPort, SerialPortSettings};
use std::fmt::Display;
use std::time::{Duration, Instant};

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);
const CLIENT_TIMEOUT: Duration = Duration::from_secs(10);
const POLL_INTERVAL: Duration = Duration::from_millis(5);

enum BridgeStatus {
    Disconnected,
    Connected(Box<dyn SerialPort>),
}

pub struct BridgeSession {
    last_seen: Instant,
    status: BridgeStatus,
}

impl BridgeSession {
    pub fn new() -> BridgeSession {
        BridgeSession {
            last_seen: Instant::now(),
            status: BridgeStatus::Disconnected,
        }
    }

    fn send_status(&self, ctx: &mut WebsocketContext<Self>) {
        let conn_status = match self.status {
            BridgeStatus::Disconnected => "DOWN",
            BridgeStatus::Connected(_) => "UP",
        };
        let mut resp = String::from("OK: ");
        resp.push_str(conn_status);
        ctx.text(resp);
    }

    fn send_error(&self, ctx: &mut WebsocketContext<Self>, err: impl Display) {
        ctx.text(format!("ERROR: {}", err));
    }

    fn list(&self, ctx: &mut WebsocketContext<Self>) {
        let ports: Vec<String> = serialport::available_ports()
            .unwrap_or_default()
            .into_iter()
            .map(|port| port.port_name)
            .collect();
        let mut resp = String::from("LIST: ");
        resp.push_str(&ports.join(" "));
        ctx.text(resp);
    }

    fn connect(&mut self, ctx: &mut WebsocketContext<Self>, args: &[&str]) {
        let mut settings = SerialPortSettings::default();
        if args.is_empty() {
            return self.send_error(ctx, "Port is required");
        }
        if let Some(baud_rate) = args.get(1) {
            match baud_rate.parse() {
                Ok(baud_rate) => settings.baud_rate = baud_rate,
                Err(err) => return self.send_error(ctx, err),
            }
        }
        match serialport::open_with_settings(args[0], &settings) {
            Ok(serial_port) => {
                self.status = BridgeStatus::Connected(serial_port);
                self.send_status(ctx);
            }
            Err(err) => {
                self.status = BridgeStatus::Disconnected;
                self.send_error(ctx, err);
            }
        }
    }

    fn disconnect(&mut self, ctx: &mut WebsocketContext<Self>) {
        self.status = BridgeStatus::Disconnected;
        self.send_status(ctx);
    }

    fn blob(&mut self, ctx: &mut WebsocketContext<Self>, data: Bytes) {
        match &mut self.status {
            BridgeStatus::Disconnected => self.send_error(ctx, "Disconnected"),
            BridgeStatus::Connected(port) => {
                if let Err(err) = port.write_all(data.as_ref()) {
                    self.send_error(ctx, err);
                }
            }
        };
    }

    fn poll_serial(&mut self, ctx: &mut WebsocketContext<BridgeSession>) {
        if let BridgeStatus::Connected(port) = &mut self.status {
            while let Ok(len) = port.bytes_to_read() {
                if len == 0 {
                    break;
                }
                let mut buff = [0u8; 64 * 1024];
                match port.read(&mut buff) {
                    Ok(n) => {
                        let mut data = Bytes::new();
                        data.extend_from_slice(&buff[..n]);
                        ctx.binary(data);
                    }
                    Err(err) => {
                        self.send_error(ctx, err);
                        break;
                    }
                }
            }
        }
        ctx.run_later(POLL_INTERVAL, |act, ctx| act.poll_serial(ctx));
    }
}

impl Actor for BridgeSession {
    type Context = WebsocketContext<Self>;

    fn started(&mut self, ctx: &mut Self::Context) {
        ctx.run_interval(HEARTBEAT_INTERVAL, |act, ctx| {
            if Instant::now().duration_since(act.last_seen) < CLIENT_TIMEOUT {
                return ctx.ping("");
            }
            ctx.stop();
        });
        ctx.run_later(POLL_INTERVAL, |act, ctx| act.poll_serial(ctx));
    }
}

impl StreamHandler<Message, ProtocolError> for BridgeSession {
    fn handle(&mut self, msg: Message, ctx: &mut Self::Context) {
        match msg {
            Message::Binary(data) => self.blob(ctx, data),
            Message::Text(text) => {
                let params: Vec<&str> = text.split(' ').collect();
                if let Some((command, args)) = params.split_first() {
                    match *command {
                        "STATUS" => self.send_status(ctx),
                        "CONNECT" => self.connect(ctx, args),
                        "DISCONNECT" => self.disconnect(ctx),
                        "LIST" => self.list(ctx),
                        _ => self.send_error(ctx, "Unsupported command"),
                    }
                } else {
                    ctx.binary(text);
                }
            }
            Message::Ping(msg) => {
                self.last_seen = Instant::now();
                ctx.pong(&msg);
            }
            Message::Pong(_) => {
                self.last_seen = Instant::now();
            }
            Message::Close(_) => ctx.stop(),
            Message::Nop => (),
        }
    }
}
