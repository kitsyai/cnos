<?php

declare(strict_types=1);

namespace Kitsy\Cnos;

/**
 * Evaluates CNOS derived-value formulas.
 *
 * Supported expression forms:
 *   Template:   "Hello ${value.name}!"
 *   Fallback:   value.x ?? "default"
 *   Ternary:    value.flag ? "yes" : "no"
 *   Key ref:    value.some.key
 *   Literals:   "string", 42, 3.14, true, false, null
 */
class FormulaEvaluator
{
    /**
     * @param callable(string): array{mixed, bool} $resolver
     */
    public static function evaluate(DerivedFormula $formula, callable $resolver): mixed
    {
        $expr = trim($formula->expr);

        if (str_contains($expr, '${')) {
            return self::evaluateTemplate($expr, $resolver);
        }

        return self::evaluateExpr($expr, $resolver);
    }

    private static function evaluateTemplate(string $expr, callable $resolver): string
    {
        return (string) preg_replace_callback(
            '/\$\{([^}]+)\}/',
            static function (array $m) use ($resolver): string {
                [$value, $found] = $resolver(trim($m[1]));
                if (!$found || $value === null) {
                    return '';
                }
                return is_string($value) ? $value : (string) json_encode($value);
            },
            $expr
        );
    }

    private static function evaluateExpr(string $expr, callable $resolver): mixed
    {
        $expr = trim($expr);

        // String literals
        if (preg_match('/^"(.*)"$/s', $expr, $m) || preg_match("/^'(.*)'$/s", $expr, $m)) {
            return $m[1];
        }

        // Numeric literals
        if (is_numeric($expr)) {
            return str_contains($expr, '.') ? (float) $expr : (int) $expr;
        }

        // Boolean / null literals
        if ($expr === 'true')  return true;
        if ($expr === 'false') return false;
        if ($expr === 'null')  return null;

        // Fallback: lhs ?? rhs — split on last ?? so rhs may also contain ??
        $qqPos = self::findOperator($expr, '??');
        if ($qqPos !== false) {
            $lhs = trim(substr($expr, 0, $qqPos));
            $rhs = trim(substr($expr, $qqPos + 2));
            [$value, $found] = $resolver($lhs);
            if ($found && $value !== null && $value !== '') {
                return $value;
            }
            return self::evaluateExpr($rhs, $resolver);
        }

        // Ternary: condition ? then : else
        $ternaryQ = self::findOperator($expr, '?');
        if ($ternaryQ !== false) {
            $colonPos = self::findOperator($expr, ':', $ternaryQ + 1);
            if ($colonPos !== false) {
                $cond = trim(substr($expr, 0, $ternaryQ));
                $then = trim(substr($expr, $ternaryQ + 1, $colonPos - $ternaryQ - 1));
                $else = trim(substr($expr, $colonPos + 1));
                [$condVal, $condFound] = $resolver($cond);
                $branch = ($condFound && $condVal) ? $then : $else;
                return self::evaluateExpr($branch, $resolver);
            }
        }

        // Plain key reference
        [$value, $found] = $resolver($expr);
        return $found ? $value : null;
    }

    /**
     * Find the position of $operator in $str, ignoring occurrences inside
     * quoted strings. Returns false if not found.
     */
    private static function findOperator(string $str, string $op, int $start = 0): int|false
    {
        $len    = strlen($str);
        $opLen  = strlen($op);
        $inStr  = false;
        $quote  = '';

        for ($i = $start; $i < $len; $i++) {
            $ch = $str[$i];
            if ($inStr) {
                if ($ch === '\\') { $i++; continue; }
                if ($ch === $quote) { $inStr = false; }
                continue;
            }
            if ($ch === '"' || $ch === "'") { $inStr = true; $quote = $ch; continue; }

            if (substr($str, $i, $opLen) === $op) {
                return $i;
            }
        }
        return false;
    }
}
