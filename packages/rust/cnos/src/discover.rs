use std::path::{Path, PathBuf};
use crate::error::CnosError;

pub const PROJECTION_FILE_NAME: &str = ".cnos-server.json";

pub fn resolve_working_dir(working_dir: Option<&str>) -> Result<PathBuf, CnosError> {
    match working_dir {
        Some(dir) if !dir.is_empty() => {
            std::fs::canonicalize(dir).map_err(|e| CnosError::IoError(e.to_string()))
        }
        _ => std::env::current_dir().map_err(|e| CnosError::IoError(e.to_string())),
    }
}

pub fn resolve_path_from_working_dir(working_dir: Option<&str>, target: &str) -> Result<PathBuf, CnosError> {
    if Path::new(target).is_absolute() {
        return Ok(PathBuf::from(target));
    }
    let base = resolve_working_dir(working_dir)?;
    Ok(base.join(target))
}

pub fn find_projection_path(working_dir: Option<&str>) -> Result<Option<PathBuf>, CnosError> {
    let cwd = resolve_working_dir(working_dir)?;

    let direct = cwd.join(PROJECTION_FILE_NAME);
    if direct.is_file() {
        return Ok(Some(direct));
    }

    let mut current = cwd.clone();
    for _ in 0..=3 {
        let rc = current.join(".cnosrc.yml");
        if rc.is_file() {
            let candidate = current.join(PROJECTION_FILE_NAME);
            if candidate.is_file() {
                return Ok(Some(candidate));
            }
        }
        let parent = match current.parent() {
            Some(p) if p != current => p.to_path_buf(),
            _ => break,
        };
        current = parent;
    }

    Ok(None)
}

pub fn expand_home_path(value: &str) -> Result<PathBuf, CnosError> {
    if value == "~" {
        return home_dir();
    }
    if let Some(rest) = value.strip_prefix("~/") {
        let home = home_dir()?;
        return Ok(home.join(rest));
    }
    std::fs::canonicalize(value)
        .or_else(|_| Ok(PathBuf::from(value)))
}

fn home_dir() -> Result<PathBuf, CnosError> {
    // USERPROFILE on Windows, HOME on Unix
    if let Ok(home) = std::env::var("HOME") {
        return Ok(PathBuf::from(home));
    }
    if let Ok(home) = std::env::var("USERPROFILE") {
        return Ok(PathBuf::from(home));
    }
    Err(CnosError::IoError("cannot determine home directory".into()))
}
