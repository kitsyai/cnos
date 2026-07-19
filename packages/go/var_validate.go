package cnos

import (
	"fmt"
	"regexp"
	"strings"
)

// jsonTypeMatches reports whether value matches a CNOS schema type. JSON decode
// yields float64 for numbers, bool, string, map[string]any, []any.
func jsonTypeMatches(value any, typ string) bool {
	switch typ {
	case "", "any":
		return true
	case "string":
		_, ok := value.(string)
		return ok
	case "number":
		switch value.(type) {
		case float64, float32, int, int64, int32, uint, uint64, uint32:
			return true
		}
		return false
	case "boolean":
		_, ok := value.(bool)
		return ok
	case "object":
		_, ok := value.(map[string]any)
		return ok
	case "array":
		_, ok := value.([]any)
		return ok
	default:
		// Unknown declared type: do not reject on type grounds.
		return true
	}
}

func enumContains(enum []any, value any) bool {
	for _, candidate := range enum {
		if jsStrictEqual(candidate, value) {
			return true
		}
	}
	return false
}

func validatePattern(pattern string, value any) error {
	str, ok := value.(string)
	if !ok {
		return fmt.Errorf("pattern requires a string value, got %T", value)
	}
	compiled, err := regexp.Compile(pattern)
	if err != nil {
		return fmt.Errorf("invalid pattern %q: %w", pattern, err)
	}
	if !compiled.MatchString(str) {
		return fmt.Errorf("value %q does not match pattern %q", str, pattern)
	}
	return nil
}

// validateDocumentField checks one field value against its declared type, enum
// and pattern.
func validateDocumentField(name string, value any, field DocumentField) error {
	if field.Type != "" && !jsonTypeMatches(value, field.Type) {
		return fmt.Errorf("field %q expected type %s, got %T", name, field.Type, value)
	}
	if len(field.Enum) > 0 && !enumContains(field.Enum, value) {
		return fmt.Errorf("field %q value %v not in enum", name, value)
	}
	if field.Pattern != "" {
		if err := validatePattern(field.Pattern, value); err != nil {
			return fmt.Errorf("field %q: %w", name, err)
		}
	}
	return nil
}

// validateDocument runs whole-document validation: required fields present,
// declared fields well-typed, and — when additionalProperties is false —
// unknown fields rejected.
func validateDocument(value any, schema DocumentSchema) error {
	object, ok := value.(map[string]any)
	if !ok {
		return fmt.Errorf("expected object document, got %T", value)
	}
	for name, field := range schema.Fields {
		fieldValue, present := object[name]
		if !present {
			if field.Required {
				return fmt.Errorf("missing required field %q", name)
			}
			continue
		}
		if err := validateDocumentField(name, fieldValue, field); err != nil {
			return err
		}
	}
	if !schema.AdditionalProperties {
		for name := range object {
			if _, declared := schema.Fields[name]; !declared {
				return fmt.Errorf("unknown field %q", name)
			}
		}
	}
	return detectInlineSecret(value)
}

// detectInlineSecret rejects obvious inline secret material. Documents may carry
// opaque secret.* references (strings), never inline secret values. This is a
// best-effort guard: it flags strings that look like an unreferenced secret
// payload while allowing secret.* refs through.
func detectInlineSecret(value any) error {
	switch typed := value.(type) {
	case map[string]any:
		for key, item := range typed {
			lowered := strings.ToLower(key)
			if strings.Contains(lowered, "password") || strings.Contains(lowered, "private_key") {
				if str, ok := item.(string); ok && str != "" && !strings.HasPrefix(str, "secret.") {
					return fmt.Errorf("inline secret material detected in field %q; use a secret.* reference", key)
				}
			}
			if err := detectInlineSecret(item); err != nil {
				return err
			}
		}
	case []any:
		for _, item := range typed {
			if err := detectInlineSecret(item); err != nil {
				return err
			}
		}
	}
	return nil
}

// validateVarValue validates an inbound value for a var key against its per-key
// rule (document binding or scalar type/enum/pattern). Called on every inbound
// revision BEFORE commit; an invalid value never replaces last-known-good.
func (variables *varRuntime) validateVarValue(fullKey string, value any) error {
	rule, hasRule := variables.rules[fullKey]
	if !hasRule {
		// No declared rule: accept as-is but still guard inline secrets.
		return detectInlineSecret(value)
	}
	if rule.Document != "" {
		schema, ok := variables.documents[rule.Document]
		if !ok {
			return fmt.Errorf("unknown document schema %q for %s", rule.Document, fullKey)
		}
		return validateDocument(value, schema)
	}
	if rule.Type != "" && value != nil && !jsonTypeMatches(value, rule.Type) {
		return fmt.Errorf("expected type %s, got %T", rule.Type, value)
	}
	if len(rule.Enum) > 0 && !enumContains(rule.Enum, value) {
		return fmt.Errorf("value %v not in enum", value)
	}
	if rule.Pattern != "" {
		if err := validatePattern(rule.Pattern, value); err != nil {
			return err
		}
	}
	return detectInlineSecret(value)
}
