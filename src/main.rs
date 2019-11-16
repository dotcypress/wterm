#[cfg(debug_assertions)]
use actix_files::NamedFile;
use actix_web::{web, App, Error, HttpRequest, HttpResponse, HttpServer, Result};
use actix_web_actors::ws;
use std::net::SocketAddr;
#[cfg(debug_assertions)]
use std::path::PathBuf;
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

#[cfg(debug_assertions)]
fn index(req: HttpRequest) -> Result<NamedFile> {
    let filename: String = req
        .match_info()
        .query("filename")
        .parse()
        .expect("Failed to parse filename");
    let mut path: PathBuf = PathBuf::from("./static");
    if filename.is_empty() {
        path.push("index.html");
    } else {
        path.push(filename);
    }
    Ok(NamedFile::open(path)?)
}

#[cfg(not(debug_assertions))]
fn index(req: HttpRequest) -> HttpResponse {
    static ICON: &'static [u8] = include_bytes!("./../static/favicon.png");
    static HOME: &'static str = include_str!("./../static/index.html");
    static CSS: &'static str = include_str!("./../static/wterm.css");
    static JS: &'static str = include_str!("./../static/wterm.js");

    let filename = req
        .match_info()
        .query("filename")
        .parse::<String>()
        .expect("Failed to parse filename");

    match filename.as_ref() {
        "" | "index.html" => HttpResponse::Ok()
            .content_type("text/html; charset=utf-8")
            .body(HOME),
        "wterm.js" => HttpResponse::Ok()
            .content_type("text/javascript; charset=utf-8")
            .body(JS),
        "wterm.css" => HttpResponse::Ok().content_type("text/css").body(CSS),
        "favicon.png" => HttpResponse::Ok().content_type("image/png").body(ICON),
        _ => HttpResponse::NotFound().finish(),
    }
}

fn ws_bridge(req: HttpRequest, stream: web::Payload) -> Result<HttpResponse, Error> {
    ws::start(bridge::BridgeSession::new(), &req, stream)
}

fn main() {
    let cli = Cli::from_args();
    println!("http://{}", cli.addr);
    HttpServer::new(move || {
        App::new()
            .service(web::resource("/ws").to(ws_bridge))
            .route("/{filename:.*}", web::get().to(index))
    })
    .bind(cli.addr)
    .expect("Failed to bind to network interface")
    .run()
    .expect("Failed to start server");
}
