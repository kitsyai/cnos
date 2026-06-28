use serde_json::Value;

pub fn js_stringify_value(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(b) => if *b { "true".into() } else { "false".into() },
        Value::String(s) => s.clone(),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                i.to_string()
            } else if let Some(f) = n.as_f64() {
                js_number_string(f)
            } else {
                n.to_string()
            }
        }
        Value::Array(_) | Value::Object(_) => value.to_string(),
    }
}

pub fn js_log_stringify_value(value: &Value) -> String {
    if value.is_null() { "null".into() } else { js_stringify_value(value) }
}

pub fn js_number_string(value: f64) -> String {
    if value.is_nan() { return "NaN".into(); }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if value == 0.0 { return "0".into(); }

    let abs = value.abs();
    if abs >= 1e-6 && abs < 1e21 {
        // Use Display which gives us decimal without trailing zeros for integers
        let s = format!("{}", value);
        return s;
    }

    // Scientific notation — match JS format
    let s = format!("{:e}", value);
    // Rust gives e.g. "1.5e10", JS gives "1.5e+10"
    if let Some(e_pos) = s.find('e') {
        let mantissa = &s[..e_pos];
        let exp_str = &s[e_pos + 1..];
        let (sign, digits) = if exp_str.starts_with('-') {
            ("-", &exp_str[1..])
        } else {
            ("+", exp_str)
        };
        let digits = digits.trim_start_matches('0');
        let digits = if digits.is_empty() { "0" } else { digits };
        format!("{}e{}{}", mantissa, sign, digits)
    } else {
        s
    }
}

pub fn js_strict_equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Null, Value::Null) => true,
        (Value::Bool(l), Value::Bool(r)) => l == r,
        (Value::String(l), Value::String(r)) => l == r,
        _ => {
            let ln = numeric_value(left);
            let rn = numeric_value(right);
            match (ln, rn) {
                (Some(l), Some(r)) => !l.is_nan() && !r.is_nan() && l == r,
                _ => false,
            }
        }
    }
}

fn numeric_value(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        _ => None,
    }
}

pub fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(false),
        Value::Array(_) | Value::Object(_) => true,
    }
}

pub fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        "linux" => "linux",
        "freebsd" => "freebsd",
        "openbsd" => "openbsd",
        "netbsd" => "netbsd",
        other => other,
    }
}

pub fn node_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "x86" => "ia32",
        "aarch64" => "arm64",
        "arm" => "arm",
        "powerpc64" => "ppc64",
        "s390x" => "s390x",
        "riscv64" => "riscv64",
        other => other,
    }
}
