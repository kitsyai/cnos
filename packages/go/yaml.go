package cnos

import (
	"fmt"
	"sort"

	"gopkg.in/yaml.v3"
)

func decodeYAMLDocument[T any](source []byte, target *T) error {
	if err := yaml.Unmarshal(source, target); err != nil {
		return fmt.Errorf("cnos: parse YAML: %w", err)
	}
	return nil
}

func parseNormalizedYAMLDocument(source []byte) (any, error) {
	var value any
	if err := yaml.Unmarshal(source, &value); err != nil {
		return nil, fmt.Errorf("cnos: parse YAML: %w", err)
	}
	return normalizeYAMLValue(value), nil
}

func normalizeYAMLValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		normalized := make(map[string]any, len(typed))
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			normalized[key] = normalizeYAMLValue(typed[key])
		}
		return normalized
	case map[any]any:
		normalized := make(map[string]any, len(typed))
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, fmt.Sprint(key))
		}
		sort.Strings(keys)
		for _, key := range keys {
			normalized[key] = normalizeYAMLValue(typed[key])
		}
		return normalized
	case []any:
		normalized := make([]any, len(typed))
		for index, item := range typed {
			normalized[index] = normalizeYAMLValue(item)
		}
		return normalized
	case int:
		return float64(typed)
	case int8:
		return float64(typed)
	case int16:
		return float64(typed)
	case int32:
		return float64(typed)
	case int64:
		return float64(typed)
	case uint:
		return float64(typed)
	case uint8:
		return float64(typed)
	case uint16:
		return float64(typed)
	case uint32:
		return float64(typed)
	case uint64:
		return float64(typed)
	case float32:
		return float64(typed)
	default:
		return typed
	}
}
