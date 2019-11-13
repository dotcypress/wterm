use actix_files::Files;
use actix_web::{web, App, Error, HttpRequest, HttpResponse, HttpServer, Result};
use actix_web_actors::ws;
use std::net::SocketAddr;
use structopt::StructOpt;

mod bridge;

#[derive(Debug, StructOpt)]
struct Cli {
    #[structopt(
        short = "a",
        long = "addr",
        default_value = "127.0.0.1:4242",
        help = "Webserver address."
    )]
    addr: SocketAddr,
}

fn ws_bridge(req: HttpRequest, stream: web::Payload) -> Result<HttpResponse, Error> {
    ws::start(bridge::BridgeSession::new(), &req, stream)
}

fn main() {
    let cli = Cli::from_args();
    println!("wterm: http://{}", cli.addr);
    HttpServer::new(move || {
        App::new()
            .service(web::resource("/ws").to(ws_bridge))
            .service(Files::new("", "static").index_file("index.html"))
    })
    .bind(cli.addr)
    .expect("Failed to bind to network interface")
    .run()
    .expect("Failed to start server");

}
