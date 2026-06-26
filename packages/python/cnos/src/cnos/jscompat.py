"""JS-compatible number/string formatting — mirrors Go's jscompat.go."""
from __future__ import annotations

import json
import math
import platform
import sys
from typing import Any


def js_stringify_value(value: Any) -> str:
    """Serialize a value the same way JS String(value) would."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return js_number_string(value)
    if isinstance(value, str):
        return value
    # Fallback: JSON
    try:
        return json.dumps(value, separators=(",", ":"))
    except (TypeError, ValueError):
        return str(value)


def js_log_stringify_value(value: Any) -> str:
    """Like js_stringify_value but None -> 'null'."""
    if value is None:
        return "null"
    return js_stringify_value(value)


def js_number_string(value: float) -> str:
    """Format a float64 the same way V8 does."""
    if math.isnan(value):
        return "NaN"
    if math.isinf(value):
        return "Infinity" if value > 0 else "-Infinity"
    if value == 0:
        return "0"

    abs_val = abs(value)
    if 1e-6 <= abs_val < 1e21:
        # Use 'g' with enough precision, then strip unnecessary zeros
        formatted = f"{value:.17g}"
        # Python's g format is close; strip trailing zeros after decimal
        if "." in formatted:
            formatted = formatted.rstrip("0").rstrip(".")
        return formatted

    # Exponential notation
    import re
    formatted = f"{value:.16e}"
    # Format: 1.23456789e+10  ->  JS: 1.23456789e+10
    match = re.match(r"^(-?\d+\.?\d*?)0*e([+-])0*(\d+)$", formatted)
    if match:
        mantissa = match.group(1).rstrip(".")
        sign = match.group(2)
        exp = match.group(3).lstrip("0") or "0"
        result = f"{mantissa}e{sign}{exp}"
        return result
    return formatted


def js_strict_equal(left: Any, right: Any) -> bool:
    """JS === semantics: same type and same value, NaN != NaN."""
    if left is None and right is None:
        return True
    if left is None or right is None:
        return False
    if isinstance(left, bool) and isinstance(right, bool):
        return left == right
    if isinstance(left, str) and isinstance(right, str):
        return left == right
    # Numeric comparison
    left_num, left_is_num = _numeric_value(left)
    right_num, right_is_num = _numeric_value(right)
    if left_is_num or right_is_num:
        if not left_is_num or not right_is_num:
            return False
        if math.isnan(left_num) or math.isnan(right_num):
            return False
        return left_num == right_num
    return False


def _numeric_value(value: Any):
    """Return (float64, is_numeric)."""
    if isinstance(value, bool):
        # bool is subclass of int in Python — but JS treats booleans separately
        return 0, False
    if isinstance(value, int):
        return float(value), True
    if isinstance(value, float):
        return value, True
    return 0.0, False


def node_platform() -> str:
    """Return Node-compatible platform string."""
    system = sys.platform
    if system == "win32":
        return "win32"
    if system == "darwin":
        return "darwin"
    if system.startswith("linux"):
        return "linux"
    if system.startswith("freebsd"):
        return "freebsd"
    if system.startswith("openbsd"):
        return "openbsd"
    if system.startswith("netbsd"):
        return "netbsd"
    if system == "aix":
        return "aix"
    if system == "sunos":
        return "sunos"
    return system


def node_arch() -> str:
    """Return Node-compatible architecture string."""
    machine = platform.machine().lower()
    if machine in ("amd64", "x86_64"):
        return "x64"
    if machine in ("i386", "i686", "x86"):
        return "ia32"
    if machine == "arm":
        return "arm"
    if machine in ("arm64", "aarch64"):
        return "arm64"
    if machine == "ppc64":
        return "ppc64"
    if machine == "ppc64le":
        return "ppc64le"
    if machine == "mips64el":
        return "mips64el"
    if machine == "mips64":
        return "mips64"
    if machine == "s390x":
        return "s390x"
    if machine == "riscv64":
        return "riscv64"
    if machine == "loongarch64":
        return "loong64"
    return machine
