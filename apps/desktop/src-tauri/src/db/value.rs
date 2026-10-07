//! JSON 与 SQLite 值的互转，与 packages/store/src/sql.ts 的 SqlValue 对应：null、数字、文本。

use rusqlite::types::{Value as SqlValue, ValueRef};
use serde_json::{Number, Value};

/// JavaScript 的安全整数上限；超出的整数在 WebView 中会丢失精度，按错误处理。
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

pub fn to_sql(value: &Value) -> Result<SqlValue, String> {
    match value {
        Value::Null => Ok(SqlValue::Null),
        Value::String(s) => Ok(SqlValue::Text(s.clone())),
        Value::Number(n) => match n.as_i64() {
            Some(i) => Ok(SqlValue::Integer(i)),
            None => n
                .as_f64()
                .map(SqlValue::Real)
                .ok_or_else(|| "数字超出范围".to_string()),
        },
        Value::Bool(_) | Value::Array(_) | Value::Object(_) => {
            Err("参数只能是 null、数字或文本".into())
        }
    }
}

pub fn from_sql(value: ValueRef<'_>) -> Result<Value, String> {
    match value {
        ValueRef::Null => Ok(Value::Null),
        ValueRef::Integer(i) if i.abs() > MAX_SAFE_INTEGER => Err("整数超出安全范围".into()),
        ValueRef::Integer(i) => Ok(Value::Number(i.into())),
        ValueRef::Real(f) => Number::from_f64(f)
            .map(Value::Number)
            .ok_or_else(|| "非有限浮点数".to_string()),
        ValueRef::Text(bytes) => String::from_utf8(bytes.to_vec())
            .map(Value::String)
            .map_err(|_| "文本不是有效的 UTF-8".to_string()),
        ValueRef::Blob(_) => Err("首版不支持二进制列".into()),
    }
}
