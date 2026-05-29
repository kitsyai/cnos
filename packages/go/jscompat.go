package cnos

import (
	"encoding/json"
	"fmt"
	"math"
	goruntime "runtime"
	"strconv"
	"strings"
)

func jsStringifyValue(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case bool:
		return strconv.FormatBool(typed)
	case float64:
		return jsNumberString(typed)
	case float32:
		return jsNumberString(float64(typed))
	case int:
		return strconv.FormatInt(int64(typed), 10)
	case int64:
		return strconv.FormatInt(typed, 10)
	case int32:
		return strconv.FormatInt(int64(typed), 10)
	case uint:
		return strconv.FormatUint(uint64(typed), 10)
	case uint64:
		return strconv.FormatUint(typed, 10)
	case uint32:
		return strconv.FormatUint(uint64(typed), 10)
	default:
		encoded, err := json.Marshal(typed)
		if err != nil {
			return fmt.Sprint(typed)
		}
		return string(encoded)
	}
}

func jsLogStringifyValue(value any) string {
	if value == nil {
		return "null"
	}
	return jsStringifyValue(value)
}

func jsNumberString(value float64) string {
	switch {
	case math.IsNaN(value):
		return "NaN"
	case math.IsInf(value, 1):
		return "Infinity"
	case math.IsInf(value, -1):
		return "-Infinity"
	case value == 0:
		return "0"
	}

	abs := math.Abs(value)
	if abs >= 1e-6 && abs < 1e21 {
		return strconv.FormatFloat(value, 'f', -1, 64)
	}

	formatted := strconv.FormatFloat(value, 'e', -1, 64)
	index := strings.IndexByte(formatted, 'e')
	if index < 0 {
		return formatted
	}

	mantissa := formatted[:index]
	exponent := formatted[index+1:]
	sign := ""
	if len(exponent) > 0 && (exponent[0] == '+' || exponent[0] == '-') {
		sign = exponent[:1]
		exponent = exponent[1:]
	}
	exponent = strings.TrimLeft(exponent, "0")
	if exponent == "" {
		exponent = "0"
	}
	return mantissa + "e" + sign + exponent
}

func jsStrictEqual(left, right any) bool {
	switch leftValue := left.(type) {
	case nil:
		return right == nil
	case bool:
		rightValue, ok := right.(bool)
		return ok && leftValue == rightValue
	case string:
		rightValue, ok := right.(string)
		return ok && leftValue == rightValue
	}

	leftNumber, leftIsNumber := numericValue(left)
	rightNumber, rightIsNumber := numericValue(right)
	if leftIsNumber || rightIsNumber {
		if !leftIsNumber || !rightIsNumber {
			return false
		}
		if math.IsNaN(leftNumber) || math.IsNaN(rightNumber) {
			return false
		}
		return leftNumber == rightNumber
	}

	return false
}

func numericValue(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, true
	case float32:
		return float64(typed), true
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case int32:
		return float64(typed), true
	case uint:
		return float64(typed), true
	case uint64:
		return float64(typed), true
	case uint32:
		return float64(typed), true
	default:
		return 0, false
	}
}

func nodePlatform() string {
	switch goos := runtimeGOOS(); goos {
	case "windows":
		return "win32"
	case "darwin":
		return "darwin"
	case "linux":
		return "linux"
	case "android":
		return "android"
	case "freebsd":
		return "freebsd"
	case "openbsd":
		return "openbsd"
	case "netbsd":
		return "netbsd"
	case "aix":
		return "aix"
	case "sunos":
		return "sunos"
	default:
		return goos
	}
}

func nodeArch() string {
	switch goarch := runtimeGOARCH(); goarch {
	case "amd64":
		return "x64"
	case "386":
		return "ia32"
	case "arm":
		return "arm"
	case "arm64":
		return "arm64"
	case "ppc64":
		return "ppc64"
	case "ppc64le":
		return "ppc64le"
	case "mips64el":
		return "mips64el"
	case "mips64":
		return "mips64"
	case "s390x":
		return "s390x"
	case "riscv64":
		return "riscv64"
	case "loong64":
		return "loong64"
	default:
		return goarch
	}
}

func runtimeGOOS() string {
	return goruntime.GOOS
}

func runtimeGOARCH() string {
	return goruntime.GOARCH
}
