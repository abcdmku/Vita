package jsonsafe

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

const (
	maxJSONDepth = 1000
	maxJSONNodes = 1000000
	maxJSONBytes = 16 * 1024 * 1024
)

type LimitError struct {
	Kind string
	Max  int
}

func (e *LimitError) Error() string {
	return fmt.Sprintf("JSON %s budget exceeded", e.Kind)
}

type DuplicateObjectKeyError struct {
	Key string
}

func (e *DuplicateObjectKeyError) Error() string {
	return fmt.Sprintf("duplicate JSON object key %q", e.Key)
}

func RejectDuplicateObjectKeys(raw []byte) error {
	if len(raw) > maxJSONBytes {
		return &LimitError{Kind: "byte", Max: maxJSONBytes}
	}

	decoder := json.NewDecoder(bytes.NewReader(raw))
	nodes := 0
	if err := scanJSONValue(decoder, 0, &nodes); err != nil {
		return err
	}
	if token, err := decoder.Token(); err != io.EOF {
		if err != nil {
			return err
		}
		return fmt.Errorf("body must contain exactly one JSON value before %v", token)
	}
	return nil
}

func DecodeStrict(raw []byte, target interface{}) error {
	if err := RejectDuplicateObjectKeys(raw); err != nil {
		return err
	}

	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}

	var extra struct{}
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return errors.New("body must contain exactly one JSON value")
		}
		return err
	}
	return nil
}

func Decode(raw []byte, target interface{}) error {
	if err := RejectDuplicateObjectKeys(raw); err != nil {
		return err
	}
	return json.Unmarshal(raw, target)
}

func scanJSONValue(decoder *json.Decoder, depth int, nodes *int) error {
	if depth > maxJSONDepth {
		return &LimitError{Kind: "depth", Max: maxJSONDepth}
	}
	if *nodes >= maxJSONNodes {
		return &LimitError{Kind: "node", Max: maxJSONNodes}
	}
	*nodes++

	token, err := decoder.Token()
	if err != nil {
		return err
	}

	delim, ok := token.(json.Delim)
	if !ok {
		return nil
	}

	switch delim {
	case '{':
		seen := make(map[string]struct{})
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return err
			}
			key, ok := keyToken.(string)
			if !ok {
				return errors.New("object key must be a string")
			}
			if _, exists := seen[key]; exists {
				return &DuplicateObjectKeyError{Key: key}
			}
			seen[key] = struct{}{}
			if err := scanJSONValue(decoder, depth+1, nodes); err != nil {
				return err
			}
		}
		endToken, err := decoder.Token()
		if err != nil {
			return err
		}
		if endToken != json.Delim('}') {
			return fmt.Errorf("object closed with %v", endToken)
		}
	case '[':
		for decoder.More() {
			if err := scanJSONValue(decoder, depth+1, nodes); err != nil {
				return err
			}
		}
		endToken, err := decoder.Token()
		if err != nil {
			return err
		}
		if endToken != json.Delim(']') {
			return fmt.Errorf("array closed with %v", endToken)
		}
	default:
		return fmt.Errorf("unexpected JSON delimiter %v", delim)
	}

	return nil
}
