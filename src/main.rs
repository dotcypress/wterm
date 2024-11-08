#[cfg(debug_assertions)]
use actix_files::NamedFile;
use actix_web::{web, App, HttpRequest, HttpServer, Responder};
use bridge::Bridge;
use futures_util::stream::StreamExt;
#[cfg(debug_assertions)]
use std::path::PathBuf;
use std::{io, net::SocketAddr};
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
async fn index(req: HttpRequest) -> NamedFile {
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
    NamedFile::open(path).unwrap()
}

#[cfg(not(debug_assertions))]
async fn index(req: HttpRequest) -> actix_web::HttpResponse {
    static ICON: &[u8] = include_bytes!("./../static/favicon.png");
    static HOME: &str = include_str!("./../static/index.html");
    static JS: &str = include_str!("./../static/wterm.js");

    let filename = req
        .match_info()
        .query("filename")
        .parse::<String>()
        .expect("Failed to parse filename");

    match filename.as_ref() {
        "" | "index.html" => actix_web::HttpResponse::Ok()
            .content_type("text/html; charset=utf-8")
            .body(HOME),
        "wterm.js" => actix_web::HttpResponse::Ok()
            .content_type("text/javascript; charset=utf-8")
            .body(JS),
        "favicon.png" => actix_web::HttpResponse::Ok()
            .content_type("image/png")
            .body(ICON),
        _ => actix_web::HttpResponse::NotFound().finish(),
    }
}

async fn ws(
    req: HttpRequest,
    body: web::Payload,
    bridge: web::Data<Bridge>,
) -> actix_web::Result<impl Responder> {
    let (response, session, mut stream) = actix_ws::handle(&req, body)?;
    let serial_bridge = bridge.clone();
    let mut poll_session = session.clone();

    actix_web::rt::spawn(async move {
        serial_bridge.poll_serial(&mut poll_session).await
    });

    let ws_bridge = bridge.clone();
    let mut ws_session = session.clone();
    actix_web::rt::spawn(async move {
        while let Some(Ok(msg)) = stream.next().await {
            if ws_bridge.handle(msg, &mut ws_session).await.is_err() {
                break;
            }
        }
        let _ = ws_session.close(None).await;
    });

    Ok(response)
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> io::Result<()> {
    let cli = Cli::from_args();
    println!("http://{}", cli.addr);
    let session = Bridge::new();
    HttpServer::new(move || {
        App::new()
            .app_data(web::Data::new(session.clone()))
            .service(web::resource("/ws").to(ws))
            .route("/{filename:.*}", web::get().to(index))
    })
    .bind(cli.addr)
    .expect("Failed to bind to network interface")
    .run()
    .await?;

    Ok(())
}
