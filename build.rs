use std::path::Path;
use std::process::Command;

fn main() {
    Command::new("npm")
        .args(&["run", "build"])
        .current_dir(&Path::new("web"))
        .status()
        .ok();
}
