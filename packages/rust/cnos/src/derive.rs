use serde_json::Value;
use crate::error::CnosError;
use crate::projection::DerivedFormula;

#[derive(Debug, Clone)]
pub enum ExprNode {
    Literal(Value),
    Ref(String),
    Call { name: String, args: Vec<ExprNode> },
}

#[derive(Debug, Clone)]
pub struct ParsedFormula {
    pub raw: String,
    pub refs: Vec<String>,
    pub deps: Vec<String>,
    pub runtime_refs: Vec<String>,
    pub runtime_dependent: bool,
    pub ast: ExprNode,
}

static DERIVE_BUILTINS: &[&str] = &["concat", "coalesce", "when", "exists", "eq", "ne"];

pub fn parse_derived_formula(formula: &DerivedFormula) -> Result<ParsedFormula, CnosError> {
    let ast = parse_derived_source(&formula.expr)?;
    let mut refs = formula.deps.clone();
    refs.extend_from_slice(&formula.runtime_refs);
    refs = unique_sorted_strings(refs);
    Ok(ParsedFormula {
        raw: formula.expr.clone(),
        refs,
        deps: formula.deps.clone(),
        runtime_refs: formula.runtime_refs.clone(),
        runtime_dependent: !formula.runtime_refs.is_empty(),
        ast,
    })
}

pub fn parse_raw_derived_value(value: &Value) -> Result<ParsedFormula, CnosError> {
    let source = derive_source_from_value(value)?;
    let ast = parse_derived_source(&source)?;
    let refs = extract_refs(&ast);
    let refs = unique_sorted_strings(refs);
    Ok(ParsedFormula {
        raw: source,
        refs: refs.clone(),
        deps: refs,
        runtime_refs: vec![],
        runtime_dependent: false,
        ast,
    })
}

pub fn is_derived_value(value: &Value) -> bool {
    value.as_object().map(|o| o.contains_key("$derive")).unwrap_or(false)
}

fn derive_source_from_value(value: &Value) -> Result<String, CnosError> {
    let doc = value.as_object()
        .ok_or_else(|| CnosError::ParseError("derived value requires a template string or {expr} object".into()))?;
    let raw = doc.get("$derive")
        .ok_or_else(|| CnosError::ParseError("derived value requires a template string or {expr} object".into()))?;

    if let Some(s) = raw.as_str() {
        return Ok(s.to_string());
    }
    if let Some(inner) = raw.as_object() {
        if let Some(expr) = inner.get("expr").and_then(|v| v.as_str()) {
            if !expr.trim().is_empty() {
                return Ok(expr.to_string());
            }
        }
    }
    Err(CnosError::ParseError("derived value requires a template string or {expr} object".into()))
}

pub fn parse_derived_source(source: &str) -> Result<ExprNode, CnosError> {
    if source.contains("${") {
        return parse_template(source);
    }
    let mut state = ParserState::new(source);
    let node = parse_expression_node(&mut state)?;
    state.skip_whitespace();
    if state.index != state.source.len() {
        return Err(state.error("Unexpected trailing input"));
    }
    Ok(node)
}

fn parse_template(source: &str) -> Result<ExprNode, CnosError> {
    let mut parts: Vec<ExprNode> = Vec::new();
    let src = source.as_bytes();
    let mut cursor = 0usize;

    while cursor < src.len() {
        // Find next "${"
        let remaining = &source[cursor..];
        match remaining.find("${") {
            None => {
                if cursor < source.len() {
                    parts.push(ExprNode::Literal(Value::String(source[cursor..].to_string())));
                }
                break;
            }
            Some(rel) => {
                let start = cursor + rel;
                if start > cursor {
                    parts.push(ExprNode::Literal(Value::String(source[cursor..start].to_string())));
                }
                let after_open = &source[start + 2..];
                match after_open.find('}') {
                    None => return Err(CnosError::ParseError(
                        format!("invalid derivation template: unclosed ${{...}} at position {}", start + 1))),
                    Some(rel_end) => {
                        let end = start + 2 + rel_end;
                        let ref_str = source[start + 2..end].trim();
                        if ref_str.is_empty() {
                            return Err(CnosError::ParseError(
                                format!("invalid derivation template: empty reference at position {}", start + 1)));
                        }
                        if !is_valid_template_ref(ref_str) {
                            return Err(CnosError::ParseError(
                                format!("invalid derivation template reference {:?}", ref_str)));
                        }
                        parts.push(ExprNode::Ref(ref_str.to_string()));
                        cursor = end + 1;
                    }
                }
            }
        }
    }

    if parts.is_empty() {
        return Ok(ExprNode::Literal(Value::String(String::new())));
    }
    if parts.len() == 1 {
        return Ok(parts.remove(0));
    }
    Ok(ExprNode::Call { name: "concat".into(), args: parts })
}

pub fn evaluate_derived_formula<F>(
    key: &str,
    formula: &ParsedFormula,
    resolve_ref: &F,
) -> Result<Option<Value>, CnosError>
where
    F: Fn(&str) -> Result<Option<Value>, CnosError>,
{
    let (value, found) = evaluate_node_with_found(&formula.ast, resolve_ref)?;
    if matches!(&formula.ast, ExprNode::Ref(_)) && !found {
        return Err(CnosError::DerivedError(
            format!("unable to resolve derived config key {} because {:?} is missing", key, &formula.ast)));
    }
    Ok(value)
}

fn evaluate_node_with_found<F>(node: &ExprNode, resolve: &F) -> Result<(Option<Value>, bool), CnosError>
where F: Fn(&str) -> Result<Option<Value>, CnosError>
{
    match node {
        ExprNode::Literal(v) => Ok((Some(v.clone()), true)),
        ExprNode::Ref(path) => {
            let v = resolve(path)?;
            let found = v.is_some();
            Ok((v, found))
        }
        ExprNode::Call { name, args } => {
            let mut values: Vec<Option<Value>> = Vec::with_capacity(args.len());
            let mut founds: Vec<bool> = Vec::with_capacity(args.len());
            for arg in args {
                let (v, f) = evaluate_node_with_found(arg, resolve)?;
                values.push(v);
                founds.push(f);
            }
            let result = evaluate_call(name, &values, &founds)?;
            Ok((result, true))
        }
    }
}

fn evaluate_call(name: &str, values: &[Option<Value>], founds: &[bool]) -> Result<Option<Value>, CnosError> {
    use crate::jscompat::{js_stringify_value, is_truthy, js_strict_equal};

    match name {
        "concat" => {
            let mut parts: Vec<String> = Vec::new();
            for v in values {
                let s = v.as_ref().map(|val| js_stringify_value(val)).unwrap_or_default();
                parts.push(s);
            }
            Ok(Some(Value::String(parts.join(""))))
        }
        "coalesce" => {
            for v in values {
                if v.is_some() && !matches!(v, Some(Value::Null)) {
                    return Ok(v.clone());
                }
            }
            Ok(None)
        }
        "when" => {
            let cond = values.first().and_then(|v| v.as_ref());
            let truthy = cond.map(is_truthy).unwrap_or(false);
            if truthy {
                Ok(values.get(1).and_then(|v| v.clone()))
            } else {
                Ok(values.get(2).and_then(|v| v.clone()))
            }
        }
        "exists" => {
            let found = founds.first().copied().unwrap_or(false);
            let not_null = values.first().map(|v| !matches!(v, Some(Value::Null))).unwrap_or(false);
            Ok(Some(Value::Bool(found && not_null)))
        }
        "eq" => {
            let l = values.first().and_then(|v| v.as_ref()).unwrap_or(&Value::Null);
            let r = values.get(1).and_then(|v| v.as_ref()).unwrap_or(&Value::Null);
            Ok(Some(Value::Bool(js_strict_equal(l, r))))
        }
        "ne" => {
            let l = values.first().and_then(|v| v.as_ref()).unwrap_or(&Value::Null);
            let r = values.get(1).and_then(|v| v.as_ref()).unwrap_or(&Value::Null);
            Ok(Some(Value::Bool(!js_strict_equal(l, r))))
        }
        _ => Err(CnosError::DerivedError(format!("unknown derive function: {}", name))),
    }
}

fn extract_refs(node: &ExprNode) -> Vec<String> {
    let mut refs = Vec::new();
    extract_refs_into(node, &mut refs);
    refs
}

fn extract_refs_into(node: &ExprNode, refs: &mut Vec<String>) {
    match node {
        ExprNode::Ref(path) => refs.push(path.clone()),
        ExprNode::Call { args, .. } => {
            for arg in args { extract_refs_into(arg, refs); }
        }
        ExprNode::Literal(_) => {}
    }
}

pub fn unique_sorted_strings(mut v: Vec<String>) -> Vec<String> {
    v.sort();
    v.dedup();
    v.retain(|s| !s.is_empty());
    v
}

// ---- parser internals ----

struct ParserState<'a> {
    source: &'a str,
    bytes: &'a [u8],
    index: usize,
}

impl<'a> ParserState<'a> {
    fn new(source: &'a str) -> Self {
        ParserState { source, bytes: source.as_bytes(), index: 0 }
    }
    fn error(&self, msg: &str) -> CnosError {
        CnosError::ParseError(format!("{} at position {}", msg, self.index + 1))
    }
    fn skip_whitespace(&mut self) {
        while self.index < self.bytes.len() && matches!(self.bytes[self.index], b' ' | b'\n' | b'\r' | b'\t') {
            self.index += 1;
        }
    }
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.index).copied()
    }
    fn advance(&mut self) { self.index += 1; }
}

fn parse_expression_node(s: &mut ParserState) -> Result<ExprNode, CnosError> {
    s.skip_whitespace();
    match s.peek() {
        None => Err(s.error("Unexpected token")),
        Some(b'\'') => parse_string_literal(s),
        Some(c) if c.is_ascii_digit() => parse_number_literal(s),
        Some(c) if is_ident_start(c) => parse_identifier_or_call(s),
        _ => Err(s.error("Unexpected token")),
    }
}

fn parse_string_literal(s: &mut ParserState) -> Result<ExprNode, CnosError> {
    s.advance(); // skip '
    let mut buf = String::new();
    loop {
        match s.peek() {
            None => return Err(s.error("Unterminated string literal")),
            Some(b'\\') => {
                s.advance();
                match s.peek() {
                    None => return Err(s.error("Unterminated escape sequence")),
                    Some(c) => { buf.push(c as char); s.advance(); }
                }
            }
            Some(b'\'') => { s.advance(); break; }
            Some(c) => { buf.push(c as char); s.advance(); }
        }
    }
    Ok(ExprNode::Literal(Value::String(buf)))
}

fn parse_number_literal(s: &mut ParserState) -> Result<ExprNode, CnosError> {
    let start = s.index;
    while s.peek().map(|c| c.is_ascii_digit()).unwrap_or(false) { s.advance(); }
    if s.peek() == Some(b'.') {
        s.advance();
        while s.peek().map(|c| c.is_ascii_digit()).unwrap_or(false) { s.advance(); }
    }
    let text = &s.source[start..s.index];
    let n: f64 = text.parse().map_err(|_| s.error("Invalid number"))?;
    Ok(ExprNode::Literal(Value::Number(serde_json::Number::from_f64(n)
        .ok_or_else(|| s.error("Invalid number"))?)))
}

fn parse_identifier_or_call(s: &mut ParserState) -> Result<ExprNode, CnosError> {
    let ident = parse_identifier(s)?;
    s.skip_whitespace();
    if s.peek() == Some(b'(') {
        if !DERIVE_BUILTINS.contains(&ident.as_str()) {
            return Err(CnosError::DerivedError(format!("unknown derive function: {}", ident)));
        }
        s.advance();
        let args = parse_arguments(s)?;
        return Ok(ExprNode::Call { name: ident, args });
    }
    Ok(match ident.as_str() {
        "true" => ExprNode::Literal(Value::Bool(true)),
        "false" => ExprNode::Literal(Value::Bool(false)),
        "null" => ExprNode::Literal(Value::Null),
        _ => ExprNode::Ref(ident),
    })
}

fn parse_identifier(s: &mut ParserState) -> Result<String, CnosError> {
    if s.peek().map(is_ident_start).unwrap_or(false) == false {
        return Err(s.error("Expected identifier"));
    }
    let start = s.index;
    s.advance();
    while s.peek().map(is_ident_part).unwrap_or(false) { s.advance(); }
    Ok(s.source[start..s.index].to_string())
}

fn parse_arguments(s: &mut ParserState) -> Result<Vec<ExprNode>, CnosError> {
    let mut args = Vec::new();
    s.skip_whitespace();
    if s.peek() == Some(b')') { s.advance(); return Ok(args); }
    loop {
        args.push(parse_expression_node(s)?);
        s.skip_whitespace();
        match s.peek() {
            Some(b',') => { s.advance(); s.skip_whitespace(); }
            Some(b')') => { s.advance(); return Ok(args); }
            None | Some(_) => return Err(s.error(r#"Expected "," or ")""#)),
        }
    }
}

fn is_ident_start(c: u8) -> bool {
    c.is_ascii_alphabetic() || c == b'_'
}

fn is_ident_part(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_' || c == b'.' || c == b'-'
}

fn is_valid_template_ref(s: &str) -> bool {
    let b = s.as_bytes();
    if b.is_empty() || !is_ident_start(b[0]) { return false; }
    b[1..].iter().all(|&c| is_ident_part(c))
}
