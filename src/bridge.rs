use actix_ws::{Closed, Message, Session};
use bytes::Bytes;
use serialport::{self, SerialPort};
use std::fmt::Display;
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Debug)]
enum BridgeStatus {
    Disconnected,
    Connected(Box<dyn SerialPort>),
}

#[derive(Debug, Clone)]
pub struct Bridge {
    status: Arc<Mutex<BridgeStatus>>,
}

impl Bridge {
    pub fn new() -> Bridge {
        Bridge {
            status: Arc::new(Mutex::new(BridgeStatus::Disconnected)),
        }
    }

    pub async fn handle(&self, msg: Message, session: &mut Session) -> Result<(), Closed> {
        match msg {
            Message::Close(_) => Err(Closed),
            Message::Ping(msg) => session.pong(&msg).await,
            Message::Binary(data) => self.blob(session, data).await,
            Message::Text(text) => {
                let params: Vec<&str> = text.split(' ').collect();
                if let Some((command, args)) = params.split_first() {
                    match *command {
                        "STATUS" => self.send_status(session).await,
                        "CONNECT" => self.connect(session, args).await,
                        "DISCONNECT" => self.disconnect(session).await,
                        "LIST" => self.list(session).await,
                        _ => self.send_error(session, "Unsupported command").await,
                    }
                } else {
                    session.binary(text.as_bytes().clone()).await
                }
            }
            _ => Ok(()),
        }
    }

    async fn list(&self, session: &mut Session) -> Result<(), Closed> {
        let ports: Vec<String> = serialport::available_ports()
            .unwrap_or_default()
            .into_iter()
            .map(|port| port.port_name)
            .collect();
        let mut resp = String::from("LIST: ");
        resp.push_str(&ports.join(" "));
        session.text(resp).await
    }

    async fn connect(&self, session: &mut Session, args: &[&str]) -> Result<(), Closed> {
        if args.is_empty() {
            return self.send_error(session, "Port is required").await;
        }
        let baud_rate = if let Some(baud_rate) = args.get(1) {
            match baud_rate.parse() {
                Ok(baud_rate) => baud_rate,
                Err(err) => return self.send_error(session, err).await,
            }
        } else {
            115200
        };
        match serialport::new(args[0], baud_rate).open() {
            Ok(serial_port) => {
                *self.status.lock().await = BridgeStatus::Connected(serial_port);
                self.send_status(session).await
            }
            Err(err) => {
                *self.status.lock().await = BridgeStatus::Disconnected;
                self.send_error(session, err).await
            }
        }
    }

    async fn disconnect(&self, session: &mut Session) -> Result<(), Closed> {
        *self.status.lock().await = BridgeStatus::Disconnected;
        self.send_status(session).await
    }

    async fn blob(&self, session: &mut Session, data: Bytes) -> Result<(), Closed> {
        match &mut *self.status.lock().await {
            BridgeStatus::Disconnected => self.send_error(session, "Disconnected").await,
            BridgeStatus::Connected(port) => {
                if let Err(err) = port.write_all(data.as_ref()) {
                    return self.send_error(session, err).await;
                }
                Ok(())
            }
        }
    }

    async fn send_status(&self, session: &mut Session) -> Result<(), Closed> {
        let conn_status = match *self.status.lock().await {
            BridgeStatus::Disconnected => "DOWN",
            BridgeStatus::Connected(_) => "UP",
        };
        let mut resp = String::from("OK: ");
        resp.push_str(conn_status);
        session.text(resp).await
    }

    async fn send_error(&self, session: &mut Session, err: impl Display) -> Result<(), Closed> {
        session.text(format!("ERROR: {}", err)).await
    }

    pub async fn poll_serial(&self, session: &mut Session) {
        if let BridgeStatus::Connected(port) = &mut *self.status.lock().await {
            while let Ok(len) = port.bytes_to_read() {
                if len == 0 {
                    break;
                }
                let mut buff = [0u8; 64 * 1024];
                match port.read(&mut buff) {
                    Ok(n) => {
                        let mut data = Vec::new();
                        data.extend_from_slice(&buff[..n]);
                        session.binary(data).await.ok();
                    }
                    Err(err) => {
                        self.send_error(session, err).await.ok();
                        break;
                    }
                }
            }
        }
    }
}
