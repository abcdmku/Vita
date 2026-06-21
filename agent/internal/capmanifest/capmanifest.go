package capmanifest

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"sort"
	"strconv"
	"strings"
)

const (
	supportedManifestVersion = 1
	maxSafeInteger           = 9007199254740991
	maxJSONDepth             = 1000
	maxJSONNodes             = 1000000
)

type Manifest struct {
	Capability      string
	Version         int
	DefaultRegistry *bool
	Fields          map[string]FieldSchema
	CrossFieldRules []CrossFieldRule
}

type FieldSchema struct {
	Type            string
	Required        bool
	MaxLength       *int64
	Enum            []string
	Lowercase       bool
	NoInlineSecrets bool
	Format          string
	Minimum         *int64
	Maximum         *int64
	Items           *FieldSchema
	MinItems        *int64
	MaxItems        *int64
	UniqueItems     bool
	Fields          map[string]FieldSchema
}

type CrossFieldRule struct {
	Type    string
	Control string
	Target  string
}

type jsonValue interface{}
type jsonObject map[string]jsonValue
type jsonArray []jsonValue

type compiledManifest struct {
	fieldNames      []string
	fields          map[string]compiledField
	crossFieldRules []CrossFieldRule
}

type compiledField struct {
	fieldType       string
	required        bool
	maxLength       *int64
	enumValues      map[string]struct{}
	lowercase       bool
	noInlineSecrets bool
	format          string
	minimum         *int64
	maximum         *int64
	items           *compiledField
	minItems        *int64
	maxItems        *int64
	uniqueItems     bool
	fields          map[string]compiledField
	fieldNames      []string
}

type capabilityValue interface{}
type capabilityArray []capabilityValue
type capabilityObject map[string]capabilityValue

var (
	manifestFields = map[string]struct{}{
		"capability":      {},
		"crossFieldRules": {},
		"defaultRegistry": {},
		"fields":          {},
		"version":         {},
	}
	stringSchemaFields = map[string]struct{}{
		"enum":            {},
		"format":          {},
		"lowercase":       {},
		"maxLength":       {},
		"noInlineSecrets": {},
		"required":        {},
		"type":            {},
	}
	integerSchemaFields = map[string]struct{}{
		"maximum":  {},
		"minimum":  {},
		"required": {},
		"type":     {},
	}
	booleanSchemaFields = map[string]struct{}{
		"required": {},
		"type":     {},
	}
	arraySchemaFields = map[string]struct{}{
		"items":       {},
		"maxItems":    {},
		"minItems":    {},
		"required":    {},
		"type":        {},
		"uniqueItems": {},
	}
	objectSchemaFields = map[string]struct{}{
		"fields":   {},
		"required": {},
		"type":     {},
	}
	crossFieldRuleFields = map[string]struct{}{
		"control": {},
		"target":  {},
		"type":    {},
	}
)

func LoadManifest(raw []byte) (manifest Manifest, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			manifest = Manifest{}
			err = fmt.Errorf("capability manifest loading failed")
		}
	}()

	value, err := decodeJSON(raw)
	if err != nil {
		return Manifest{}, err
	}
	return parseManifest(value)
}

func Validate(manifest Manifest, requestJSON []byte) (err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("capability manifest validation failed")
		}
	}()

	compiled, err := compileManifest(manifest)
	if err != nil {
		return err
	}

	value, err := decodeJSON(requestJSON)
	if err != nil {
		return err
	}
	request, ok := value.(jsonObject)
	if !ok {
		return errors.New("expected capability input object")
	}

	allowed := make(map[string]struct{}, len(compiled.fieldNames))
	for _, name := range compiled.fieldNames {
		allowed[name] = struct{}{}
	}
	if err := rejectUnknownFields(request, allowed, ""); err != nil {
		return err
	}

	output := make(map[string]capabilityValue, len(compiled.fieldNames))
	for _, name := range compiled.fieldNames {
		field := compiled.fields[name]
		raw, ok := request[name]
		if !ok {
			if field.required {
				return pathError(name, "required field is missing")
			}
			continue
		}

		normalized, err := validateField(raw, field, name)
		if err != nil {
			return err
		}
		output[name] = normalized
	}

	return applyCrossFieldRules(output, compiled.crossFieldRules)
}

func parseManifest(value jsonValue) (Manifest, error) {
	object, ok := value.(jsonObject)
	if !ok {
		return Manifest{}, errors.New("expected capability manifest object")
	}
	if err := rejectUnknownFields(object, manifestFields, ""); err != nil {
		return Manifest{}, err
	}

	capability, err := requiredString(object, "capability", "capability")
	if err != nil {
		return Manifest{}, err
	}
	if capability == "" {
		return Manifest{}, pathError("capability", "expected non-empty capability name")
	}

	version, err := requiredSafeInteger(object, "version", "version", -maxSafeInteger, maxSafeInteger)
	if err != nil {
		return Manifest{}, err
	}
	if version != supportedManifestVersion {
		return Manifest{}, pathError("version", "unsupported manifest version")
	}

	var defaultRegistry *bool
	if _, ok := object["defaultRegistry"]; ok {
		value, err := optionalBool(object, "defaultRegistry", "defaultRegistry")
		if err != nil {
			return Manifest{}, err
		}
		if value {
			return Manifest{}, pathError("defaultRegistry", "defaultRegistry may only be false when present")
		}
		defaultRegistry = boolPointer(false)
	}

	fieldsValue, ok := object["fields"]
	if !ok {
		return Manifest{}, pathError("fields", "required field is missing")
	}
	fieldsObject, ok := fieldsValue.(jsonObject)
	if !ok {
		return Manifest{}, pathError("fields", "expected fields object")
	}
	fields, err := parseManifestFields(fieldsObject, "fields")
	if err != nil {
		return Manifest{}, err
	}

	rulesValue, ok := object["crossFieldRules"]
	if !ok {
		return Manifest{}, pathError("crossFieldRules", "required field is missing")
	}
	rulesArray, ok := rulesValue.(jsonArray)
	if !ok {
		return Manifest{}, pathError("crossFieldRules", "expected cross-field rules array")
	}
	rules, err := parseCrossFieldRules(rulesArray, fields, "crossFieldRules")
	if err != nil {
		return Manifest{}, err
	}

	return Manifest{
		Capability:      capability,
		Version:         supportedManifestVersion,
		DefaultRegistry: defaultRegistry,
		Fields:          fields,
		CrossFieldRules: rules,
	}, nil
}

func parseManifestFields(object jsonObject, path string) (map[string]FieldSchema, error) {
	names := make([]string, 0, len(object))
	for name := range object {
		names = append(names, name)
	}
	sort.Strings(names)

	fields := make(map[string]FieldSchema, len(object))
	for _, name := range names {
		if name == "" {
			return nil, pathError(path, "expected non-empty field name")
		}
		field, err := parseFieldSchema(object[name], joinPath(path, name))
		if err != nil {
			return nil, err
		}
		fields[name] = field
	}
	return fields, nil
}

func parseFieldSchema(value jsonValue, path string) (FieldSchema, error) {
	object, ok := value.(jsonObject)
	if !ok {
		return FieldSchema{}, pathError(path, "expected field schema object")
	}

	fieldType, err := requiredString(object, "type", joinPath(path, "type"))
	if err != nil {
		return FieldSchema{}, err
	}
	required, err := requiredBool(object, "required", joinPath(path, "required"))
	if err != nil {
		return FieldSchema{}, err
	}

	switch fieldType {
	case "string":
		return parseStringFieldSchema(object, required, path)
	case "integer":
		return parseIntegerFieldSchema(object, required, path)
	case "boolean":
		return parseBooleanFieldSchema(object, required, path)
	case "array":
		return parseArrayFieldSchema(object, required, path)
	case "object":
		return parseObjectFieldSchema(object, required, path)
	default:
		return FieldSchema{}, pathError(joinPath(path, "type"), "unknown field schema type")
	}
}

func parseStringFieldSchema(object jsonObject, required bool, path string) (FieldSchema, error) {
	if err := rejectUnknownFields(object, stringSchemaFields, path); err != nil {
		return FieldSchema{}, err
	}

	_, hasFormat := object["format"]
	format, err := optionalString(object, "format", joinPath(path, "format"))
	if err != nil {
		return FieldSchema{}, err
	}
	if hasFormat && !isKnownStringFormat(format) {
		return FieldSchema{}, pathError(joinPath(path, "format"), "unknown string format")
	}

	maxLength, err := optionalSafeInteger(object, "maxLength", joinPath(path, "maxLength"), 0, maxSafeInteger)
	if err != nil {
		return FieldSchema{}, err
	}
	enumValues, err := optionalStringEnum(object, "enum", joinPath(path, "enum"))
	if err != nil {
		return FieldSchema{}, err
	}
	lowercase, err := optionalBool(object, "lowercase", joinPath(path, "lowercase"))
	if err != nil {
		return FieldSchema{}, err
	}
	noInlineSecrets, err := optionalBool(object, "noInlineSecrets", joinPath(path, "noInlineSecrets"))
	if err != nil {
		return FieldSchema{}, err
	}

	return FieldSchema{
		Type:            "string",
		Required:        required,
		MaxLength:       maxLength,
		Enum:            enumValues,
		Lowercase:       lowercase,
		NoInlineSecrets: noInlineSecrets,
		Format:          format,
	}, nil
}

func parseIntegerFieldSchema(object jsonObject, required bool, path string) (FieldSchema, error) {
	if err := rejectUnknownFields(object, integerSchemaFields, path); err != nil {
		return FieldSchema{}, err
	}

	minimum, err := optionalSafeInteger(object, "minimum", joinPath(path, "minimum"), -maxSafeInteger, maxSafeInteger)
	if err != nil {
		return FieldSchema{}, err
	}
	maximum, err := optionalSafeInteger(object, "maximum", joinPath(path, "maximum"), -maxSafeInteger, maxSafeInteger)
	if err != nil {
		return FieldSchema{}, err
	}
	if minimum != nil && maximum != nil && *minimum > *maximum {
		return FieldSchema{}, pathError(path, "minimum must be less than or equal to maximum")
	}

	return FieldSchema{
		Type:     "integer",
		Required: required,
		Minimum:  minimum,
		Maximum:  maximum,
	}, nil
}

func parseBooleanFieldSchema(object jsonObject, required bool, path string) (FieldSchema, error) {
	if err := rejectUnknownFields(object, booleanSchemaFields, path); err != nil {
		return FieldSchema{}, err
	}

	return FieldSchema{
		Type:     "boolean",
		Required: required,
	}, nil
}

func parseArrayFieldSchema(object jsonObject, required bool, path string) (FieldSchema, error) {
	if err := rejectUnknownFields(object, arraySchemaFields, path); err != nil {
		return FieldSchema{}, err
	}

	itemsValue, ok := object["items"]
	if !ok {
		return FieldSchema{}, pathError(joinPath(path, "items"), "required field is missing")
	}
	items, err := parseFieldSchema(itemsValue, joinPath(path, "items"))
	if err != nil {
		return FieldSchema{}, err
	}
	minItems, err := optionalSafeInteger(object, "minItems", joinPath(path, "minItems"), 0, maxSafeInteger)
	if err != nil {
		return FieldSchema{}, err
	}
	maxItems, err := optionalSafeInteger(object, "maxItems", joinPath(path, "maxItems"), 0, maxSafeInteger)
	if err != nil {
		return FieldSchema{}, err
	}
	if minItems != nil && maxItems != nil && *minItems > *maxItems {
		return FieldSchema{}, pathError(path, "minItems must be less than or equal to maxItems")
	}
	uniqueItems, err := optionalBool(object, "uniqueItems", joinPath(path, "uniqueItems"))
	if err != nil {
		return FieldSchema{}, err
	}

	return FieldSchema{
		Type:        "array",
		Required:    required,
		Items:       &items,
		MinItems:    minItems,
		MaxItems:    maxItems,
		UniqueItems: uniqueItems,
	}, nil
}

func parseObjectFieldSchema(object jsonObject, required bool, path string) (FieldSchema, error) {
	if err := rejectUnknownFields(object, objectSchemaFields, path); err != nil {
		return FieldSchema{}, err
	}

	fieldsValue, ok := object["fields"]
	if !ok {
		return FieldSchema{}, pathError(joinPath(path, "fields"), "required field is missing")
	}
	fieldsObject, ok := fieldsValue.(jsonObject)
	if !ok {
		return FieldSchema{}, pathError(joinPath(path, "fields"), "expected fields object")
	}
	fields, err := parseManifestFields(fieldsObject, joinPath(path, "fields"))
	if err != nil {
		return FieldSchema{}, err
	}

	return FieldSchema{
		Type:     "object",
		Required: required,
		Fields:   fields,
	}, nil
}

func parseCrossFieldRules(array jsonArray, fields map[string]FieldSchema, path string) ([]CrossFieldRule, error) {
	rules := make([]CrossFieldRule, 0, len(array))
	for index, value := range array {
		rule, err := parseCrossFieldRule(value, fields, joinPath(path, strconv.Itoa(index)))
		if err != nil {
			return nil, err
		}
		rules = append(rules, rule)
	}
	return rules, nil
}

func parseCrossFieldRule(value jsonValue, fields map[string]FieldSchema, path string) (CrossFieldRule, error) {
	object, ok := value.(jsonObject)
	if !ok {
		return CrossFieldRule{}, pathError(path, "expected cross-field rule object")
	}
	if err := rejectUnknownFields(object, crossFieldRuleFields, path); err != nil {
		return CrossFieldRule{}, err
	}

	ruleType, err := requiredString(object, "type", joinPath(path, "type"))
	if err != nil {
		return CrossFieldRule{}, err
	}
	control, err := requiredString(object, "control", joinPath(path, "control"))
	if err != nil {
		return CrossFieldRule{}, err
	}
	target, err := requiredString(object, "target", joinPath(path, "target"))
	if err != nil {
		return CrossFieldRule{}, err
	}
	if ruleType != "requireNonEmptyArrayWhenTrue" && ruleType != "requireEmptyArrayWhenFalse" {
		return CrossFieldRule{}, pathError(joinPath(path, "type"), "unknown cross-field rule type")
	}
	controlField, ok := fields[control]
	if !ok || controlField.Type != "boolean" {
		return CrossFieldRule{}, pathError(joinPath(path, "control"), "control field must reference a boolean field")
	}
	targetField, ok := fields[target]
	if !ok || targetField.Type != "array" {
		return CrossFieldRule{}, pathError(joinPath(path, "target"), "target field must reference an array field")
	}

	return CrossFieldRule{
		Type:    ruleType,
		Control: control,
		Target:  target,
	}, nil
}

func compileManifest(manifest Manifest) (compiledManifest, error) {
	if manifest.Capability == "" {
		return compiledManifest{}, pathError("capability", "expected non-empty capability name")
	}
	if manifest.Version != supportedManifestVersion {
		return compiledManifest{}, pathError("version", "unsupported manifest version")
	}
	if manifest.DefaultRegistry != nil && *manifest.DefaultRegistry {
		return compiledManifest{}, pathError("defaultRegistry", "defaultRegistry may only be false when present")
	}
	if manifest.Fields == nil {
		return compiledManifest{}, pathError("fields", "expected fields object")
	}

	fieldNames := make([]string, 0, len(manifest.Fields))
	for name := range manifest.Fields {
		if name == "" {
			return compiledManifest{}, pathError("fields", "expected non-empty field name")
		}
		fieldNames = append(fieldNames, name)
	}
	sort.Strings(fieldNames)

	fields := make(map[string]compiledField, len(manifest.Fields))
	for _, name := range fieldNames {
		field, err := compileFieldSchema(manifest.Fields[name], joinPath("fields", name), 0, map[*FieldSchema]struct{}{})
		if err != nil {
			return compiledManifest{}, err
		}
		fields[name] = field
	}

	for index, rule := range manifest.CrossFieldRules {
		path := joinPath("crossFieldRules", strconv.Itoa(index))
		if rule.Type != "requireNonEmptyArrayWhenTrue" && rule.Type != "requireEmptyArrayWhenFalse" {
			return compiledManifest{}, pathError(joinPath(path, "type"), "unknown cross-field rule type")
		}
		controlField, ok := fields[rule.Control]
		if !ok || controlField.fieldType != "boolean" {
			return compiledManifest{}, pathError(joinPath(path, "control"), "control field must reference a boolean field")
		}
		targetField, ok := fields[rule.Target]
		if !ok || targetField.fieldType != "array" {
			return compiledManifest{}, pathError(joinPath(path, "target"), "target field must reference an array field")
		}
	}

	return compiledManifest{
		fieldNames:      fieldNames,
		fields:          fields,
		crossFieldRules: append([]CrossFieldRule(nil), manifest.CrossFieldRules...),
	}, nil
}

func compileFieldSchema(field FieldSchema, path string, depth int, seen map[*FieldSchema]struct{}) (compiledField, error) {
	if depth > maxJSONDepth {
		return compiledField{}, pathError(path, "field schema nesting is too deep")
	}

	switch field.Type {
	case "string":
		return compileStringFieldSchema(field, path)
	case "integer":
		return compileIntegerFieldSchema(field, path)
	case "boolean":
		return compileBooleanFieldSchema(field, path)
	case "array":
		return compileArrayFieldSchema(field, path, depth, seen)
	case "object":
		return compileObjectFieldSchema(field, path, depth, seen)
	default:
		return compiledField{}, pathError(joinPath(path, "type"), "unknown field schema type")
	}
}

func compileStringFieldSchema(field FieldSchema, path string) (compiledField, error) {
	if field.Minimum != nil || field.Maximum != nil || field.Items != nil || field.MinItems != nil || field.MaxItems != nil || field.UniqueItems || field.Fields != nil {
		return compiledField{}, pathError(path, "string field contains unsupported constraints")
	}
	if field.MaxLength != nil && (*field.MaxLength < 0 || *field.MaxLength > maxSafeInteger) {
		return compiledField{}, pathError(joinPath(path, "maxLength"), "expected safe integer within bounds")
	}
	if field.Format != "" && !isKnownStringFormat(field.Format) {
		return compiledField{}, pathError(joinPath(path, "format"), "unknown string format")
	}

	enumValues, err := compileStringEnum(field.Enum, joinPath(path, "enum"))
	if err != nil {
		return compiledField{}, err
	}

	return compiledField{
		fieldType:       "string",
		required:        field.Required,
		maxLength:       cloneInt64Pointer(field.MaxLength),
		enumValues:      enumValues,
		lowercase:       field.Lowercase,
		noInlineSecrets: field.NoInlineSecrets,
		format:          field.Format,
	}, nil
}

func compileIntegerFieldSchema(field FieldSchema, path string) (compiledField, error) {
	if field.MaxLength != nil || field.Enum != nil || field.Lowercase || field.NoInlineSecrets || field.Format != "" || field.Items != nil || field.MinItems != nil || field.MaxItems != nil || field.UniqueItems || field.Fields != nil {
		return compiledField{}, pathError(path, "integer field contains unsupported constraints")
	}
	if field.Minimum != nil && (*field.Minimum < -maxSafeInteger || *field.Minimum > maxSafeInteger) {
		return compiledField{}, pathError(joinPath(path, "minimum"), "expected safe integer within bounds")
	}
	if field.Maximum != nil && (*field.Maximum < -maxSafeInteger || *field.Maximum > maxSafeInteger) {
		return compiledField{}, pathError(joinPath(path, "maximum"), "expected safe integer within bounds")
	}
	if field.Minimum != nil && field.Maximum != nil && *field.Minimum > *field.Maximum {
		return compiledField{}, pathError(path, "minimum must be less than or equal to maximum")
	}

	return compiledField{
		fieldType: "integer",
		required:  field.Required,
		minimum:   cloneInt64Pointer(field.Minimum),
		maximum:   cloneInt64Pointer(field.Maximum),
	}, nil
}

func compileBooleanFieldSchema(field FieldSchema, path string) (compiledField, error) {
	if field.MaxLength != nil || field.Enum != nil || field.Lowercase || field.NoInlineSecrets || field.Format != "" || field.Minimum != nil || field.Maximum != nil || field.Items != nil || field.MinItems != nil || field.MaxItems != nil || field.UniqueItems || field.Fields != nil {
		return compiledField{}, pathError(path, "boolean field contains unsupported constraints")
	}

	return compiledField{
		fieldType: "boolean",
		required:  field.Required,
	}, nil
}

func compileArrayFieldSchema(field FieldSchema, path string, depth int, seen map[*FieldSchema]struct{}) (compiledField, error) {
	if field.MaxLength != nil || field.Enum != nil || field.Lowercase || field.NoInlineSecrets || field.Format != "" || field.Minimum != nil || field.Maximum != nil || field.Fields != nil {
		return compiledField{}, pathError(path, "array field contains unsupported constraints")
	}
	if field.Items == nil {
		return compiledField{}, pathError(joinPath(path, "items"), "required field is missing")
	}
	if _, ok := seen[field.Items]; ok {
		return compiledField{}, pathError(joinPath(path, "items"), "field schema cycle is not allowed")
	}
	if field.MinItems != nil && (*field.MinItems < 0 || *field.MinItems > maxSafeInteger) {
		return compiledField{}, pathError(joinPath(path, "minItems"), "expected safe integer within bounds")
	}
	if field.MaxItems != nil && (*field.MaxItems < 0 || *field.MaxItems > maxSafeInteger) {
		return compiledField{}, pathError(joinPath(path, "maxItems"), "expected safe integer within bounds")
	}
	if field.MinItems != nil && field.MaxItems != nil && *field.MinItems > *field.MaxItems {
		return compiledField{}, pathError(path, "minItems must be less than or equal to maxItems")
	}

	seen[field.Items] = struct{}{}
	items, err := compileFieldSchema(*field.Items, joinPath(path, "items"), depth+1, seen)
	delete(seen, field.Items)
	if err != nil {
		return compiledField{}, err
	}

	return compiledField{
		fieldType:   "array",
		required:    field.Required,
		items:       &items,
		minItems:    cloneInt64Pointer(field.MinItems),
		maxItems:    cloneInt64Pointer(field.MaxItems),
		uniqueItems: field.UniqueItems,
	}, nil
}

func compileObjectFieldSchema(field FieldSchema, path string, depth int, seen map[*FieldSchema]struct{}) (compiledField, error) {
	if field.MaxLength != nil || field.Enum != nil || field.Lowercase || field.NoInlineSecrets || field.Format != "" || field.Minimum != nil || field.Maximum != nil || field.Items != nil || field.MinItems != nil || field.MaxItems != nil || field.UniqueItems {
		return compiledField{}, pathError(path, "object field contains unsupported constraints")
	}
	if field.Fields == nil {
		return compiledField{}, pathError(joinPath(path, "fields"), "required field is missing")
	}

	fieldNames := make([]string, 0, len(field.Fields))
	for name := range field.Fields {
		if name == "" {
			return compiledField{}, pathError(joinPath(path, "fields"), "expected non-empty field name")
		}
		fieldNames = append(fieldNames, name)
	}
	sort.Strings(fieldNames)

	fields := make(map[string]compiledField, len(field.Fields))
	for _, name := range fieldNames {
		compiled, err := compileFieldSchema(field.Fields[name], joinPath(joinPath(path, "fields"), name), depth+1, seen)
		if err != nil {
			return compiledField{}, err
		}
		fields[name] = compiled
	}

	return compiledField{
		fieldType:  "object",
		required:   field.Required,
		fieldNames: fieldNames,
		fields:     fields,
	}, nil
}

func validateField(value jsonValue, field compiledField, path string) (capabilityValue, error) {
	switch field.fieldType {
	case "string":
		return validateStringField(value, field, path)
	case "integer":
		return validateIntegerField(value, field, path)
	case "boolean":
		return validateBooleanField(value, path)
	case "array":
		return validateArrayField(value, field, path)
	case "object":
		return validateObjectField(value, field, path)
	default:
		return nil, pathError(path, "unknown manifest field")
	}
}

func validateStringField(value jsonValue, field compiledField, path string) (capabilityValue, error) {
	raw, ok := value.(string)
	if !ok {
		return nil, pathError(path, "expected string")
	}
	if field.noInlineSecrets && containsInlineSecretMaterial(raw) {
		return nil, pathError(path, "inline secret material is not allowed")
	}
	if field.format != "" && !validateStringFormat(raw, field.format) {
		return nil, pathError(path, "string does not match required format")
	}

	normalized := raw
	if field.lowercase {
		normalized = asciiLowercase(raw)
	}
	if field.maxLength != nil && utf16CodeUnitLength(normalized) > *field.maxLength {
		return nil, pathError(path, "string exceeds maxLength")
	}
	if field.enumValues != nil {
		if _, ok := field.enumValues[normalized]; !ok {
			return nil, pathError(path, "string is not in the allowed enum")
		}
	}
	return normalized, nil
}

func validateIntegerField(value jsonValue, field compiledField, path string) (capabilityValue, error) {
	number, ok := value.(json.Number)
	if !ok {
		return nil, pathError(path, "expected safe integer")
	}
	parsed, err := parseJSONFloat64(number)
	if err != nil || !isSafeInteger(parsed) {
		return nil, pathError(path, "expected safe integer")
	}
	if field.minimum != nil && parsed < float64(*field.minimum) {
		return nil, pathError(path, "integer is below minimum")
	}
	if field.maximum != nil && parsed > float64(*field.maximum) {
		return nil, pathError(path, "integer is above maximum")
	}
	return parsed, nil
}

func validateBooleanField(value jsonValue, path string) (capabilityValue, error) {
	boolean, ok := value.(bool)
	if !ok {
		return nil, pathError(path, "expected boolean")
	}
	return boolean, nil
}

func validateArrayField(value jsonValue, field compiledField, path string) (capabilityValue, error) {
	array, ok := value.(jsonArray)
	if !ok {
		return nil, pathError(path, "expected array")
	}
	if field.minItems != nil && int64(len(array)) < *field.minItems {
		return nil, pathError(path, "array contains fewer than minItems")
	}
	if field.maxItems != nil && int64(len(array)) > *field.maxItems {
		return nil, pathError(path, "array contains more than maxItems")
	}
	if field.items == nil {
		return nil, pathError(path, "array items schema is missing")
	}

	output := make(capabilityArray, 0, len(array))
	seen := map[string]int{}
	for index, item := range array {
		itemPath := joinPath(path, strconv.Itoa(index))
		normalized, err := validateField(item, *field.items, itemPath)
		if err != nil {
			return nil, err
		}
		if field.uniqueItems {
			key := uniqueValueKey(normalized)
			if previous, ok := seen[key]; ok {
				return nil, pathError(itemPath, fmt.Sprintf("duplicate array item also appears at %s", joinPath(path, strconv.Itoa(previous))))
			}
			seen[key] = index
		}
		output = append(output, normalized)
	}
	return output, nil
}

func validateObjectField(value jsonValue, field compiledField, path string) (capabilityValue, error) {
	object, ok := value.(jsonObject)
	if !ok {
		return nil, pathError(path, "expected object")
	}

	allowed := make(map[string]struct{}, len(field.fieldNames))
	for _, name := range field.fieldNames {
		allowed[name] = struct{}{}
	}
	if err := rejectUnknownFields(object, allowed, path); err != nil {
		return nil, err
	}

	output := make(capabilityObject, len(field.fieldNames))
	for _, name := range field.fieldNames {
		childField := field.fields[name]
		raw, ok := object[name]
		if !ok {
			if childField.required {
				return nil, pathError(joinPath(path, name), "required field is missing")
			}
			continue
		}

		normalized, err := validateField(raw, childField, joinPath(path, name))
		if err != nil {
			return nil, err
		}
		output[name] = normalized
	}
	return output, nil
}

func applyCrossFieldRules(value map[string]capabilityValue, rules []CrossFieldRule) error {
	for _, rule := range rules {
		controlValue, hasControl := value[rule.Control]
		targetValue, hasTarget := value[rule.Target]
		if !hasControl || !hasTarget {
			return pathError(rule.Target, "cross-field rule references invalid fields")
		}
		control, ok := controlValue.(bool)
		if !ok {
			return pathError(rule.Target, "cross-field rule references invalid fields")
		}
		target, ok := targetValue.(capabilityArray)
		if !ok {
			return pathError(rule.Target, "cross-field rule references invalid fields")
		}

		switch rule.Type {
		case "requireNonEmptyArrayWhenTrue":
			if control && len(target) == 0 {
				return pathError(rule.Target, fmt.Sprintf("%s must be non-empty when %s is true", rule.Target, rule.Control))
			}
		case "requireEmptyArrayWhenFalse":
			if !control && len(target) != 0 {
				return pathError(rule.Target, fmt.Sprintf("%s must be empty when %s is false", rule.Target, rule.Control))
			}
		default:
			return pathError(rule.Target, "unknown cross-field rule type")
		}
	}
	return nil
}

func decodeJSON(raw []byte) (jsonValue, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil, errors.New("empty JSON")
	}

	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	nodes := 0
	value, err := parseJSONValue(decoder, 0, &nodes)
	if err != nil {
		return nil, err
	}
	if token, err := decoder.Token(); err != io.EOF {
		if err != nil {
			return nil, err
		}
		return nil, fmt.Errorf("body must contain exactly one JSON value before %v", token)
	}
	return value, nil
}

func parseJSONValue(decoder *json.Decoder, depth int, nodes *int) (jsonValue, error) {
	if depth > maxJSONDepth {
		return nil, errors.New("JSON depth budget exceeded")
	}
	if *nodes >= maxJSONNodes {
		return nil, errors.New("JSON node budget exceeded")
	}
	*nodes++

	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}

	switch value := token.(type) {
	case json.Delim:
		switch value {
		case '{':
			object := jsonObject{}
			seen := map[string]struct{}{}
			for decoder.More() {
				keyToken, err := decoder.Token()
				if err != nil {
					return nil, err
				}
				key, ok := keyToken.(string)
				if !ok {
					return nil, errors.New("object key must be a string")
				}
				if _, exists := seen[key]; exists {
					return nil, fmt.Errorf("duplicate JSON object key %q", key)
				}
				seen[key] = struct{}{}
				child, err := parseJSONValue(decoder, depth+1, nodes)
				if err != nil {
					return nil, err
				}
				object[key] = child
			}
			endToken, err := decoder.Token()
			if err != nil {
				return nil, err
			}
			if endToken != json.Delim('}') {
				return nil, fmt.Errorf("object closed with %v", endToken)
			}
			return object, nil
		case '[':
			array := jsonArray{}
			for decoder.More() {
				child, err := parseJSONValue(decoder, depth+1, nodes)
				if err != nil {
					return nil, err
				}
				array = append(array, child)
			}
			endToken, err := decoder.Token()
			if err != nil {
				return nil, err
			}
			if endToken != json.Delim(']') {
				return nil, fmt.Errorf("array closed with %v", endToken)
			}
			return array, nil
		default:
			return nil, fmt.Errorf("unexpected JSON delimiter %v", value)
		}
	case nil:
		return nil, nil
	case string, bool, json.Number:
		return value, nil
	default:
		return nil, fmt.Errorf("unsupported JSON token %T", token)
	}
}

func rejectUnknownFields(object jsonObject, allowed map[string]struct{}, path string) error {
	names := make([]string, 0, len(object))
	for name := range object {
		names = append(names, name)
	}
	sort.Strings(names)

	for _, name := range names {
		if _, ok := allowed[name]; !ok {
			return pathError(joinPath(path, name), "unknown field")
		}
	}
	return nil
}

func requiredString(object jsonObject, key string, path string) (string, error) {
	value, ok := object[key]
	if !ok {
		return "", pathError(path, "required field is missing")
	}
	stringValue, ok := value.(string)
	if !ok {
		return "", pathError(path, "expected string")
	}
	return stringValue, nil
}

func optionalString(object jsonObject, key string, path string) (string, error) {
	value, ok := object[key]
	if !ok {
		return "", nil
	}
	stringValue, ok := value.(string)
	if !ok {
		return "", pathError(path, "expected string")
	}
	return stringValue, nil
}

func requiredBool(object jsonObject, key string, path string) (bool, error) {
	value, ok := object[key]
	if !ok {
		return false, pathError(path, "required field is missing")
	}
	boolValue, ok := value.(bool)
	if !ok {
		return false, pathError(path, "expected boolean")
	}
	return boolValue, nil
}

func optionalBool(object jsonObject, key string, path string) (bool, error) {
	value, ok := object[key]
	if !ok {
		return false, nil
	}
	boolValue, ok := value.(bool)
	if !ok {
		return false, pathError(path, "expected boolean")
	}
	return boolValue, nil
}

func requiredSafeInteger(object jsonObject, key string, path string, minimum int64, maximum int64) (int64, error) {
	value, ok := object[key]
	if !ok {
		return 0, pathError(path, "required field is missing")
	}
	return readSafeInteger(value, path, minimum, maximum)
}

func optionalSafeInteger(object jsonObject, key string, path string, minimum int64, maximum int64) (*int64, error) {
	value, ok := object[key]
	if !ok {
		return nil, nil
	}
	integer, err := readSafeInteger(value, path, minimum, maximum)
	if err != nil {
		return nil, err
	}
	return &integer, nil
}

func readSafeInteger(value jsonValue, path string, minimum int64, maximum int64) (int64, error) {
	number, ok := value.(json.Number)
	if !ok {
		return 0, pathError(path, "expected safe integer within bounds")
	}
	parsed, err := parseJSONFloat64(number)
	if err != nil || !isSafeInteger(parsed) || parsed < float64(minimum) || parsed > float64(maximum) {
		return 0, pathError(path, "expected safe integer within bounds")
	}
	return int64(parsed), nil
}

func optionalStringEnum(object jsonObject, key string, path string) ([]string, error) {
	value, ok := object[key]
	if !ok {
		return nil, nil
	}
	array, ok := value.(jsonArray)
	if !ok || len(array) == 0 {
		return nil, pathError(path, "expected non-empty string enum array")
	}

	seen := map[string]struct{}{}
	values := make([]string, 0, len(array))
	for index, item := range array {
		stringValue, ok := item.(string)
		if !ok {
			return nil, pathError(joinPath(path, strconv.Itoa(index)), "expected string enum value")
		}
		if _, exists := seen[stringValue]; exists {
			return nil, pathError(joinPath(path, strconv.Itoa(index)), "duplicate enum value")
		}
		seen[stringValue] = struct{}{}
		values = append(values, stringValue)
	}
	return values, nil
}

func compileStringEnum(values []string, path string) (map[string]struct{}, error) {
	if values == nil {
		return nil, nil
	}
	if len(values) == 0 {
		return nil, pathError(path, "expected non-empty string enum array")
	}

	seen := make(map[string]struct{}, len(values))
	for index, value := range values {
		if _, exists := seen[value]; exists {
			return nil, pathError(joinPath(path, strconv.Itoa(index)), "duplicate enum value")
		}
		seen[value] = struct{}{}
	}
	return seen, nil
}

func parseJSONFloat64(number json.Number) (float64, error) {
	value, err := strconv.ParseFloat(number.String(), 64)
	if err == nil {
		return value, nil
	}

	var numberError *strconv.NumError
	if errors.As(err, &numberError) && numberError.Err == strconv.ErrRange {
		return value, nil
	}
	return 0, err
}

func isSafeInteger(value float64) bool {
	return !math.IsNaN(value) &&
		!math.IsInf(value, 0) &&
		math.Trunc(value) == value &&
		math.Abs(value) <= maxSafeInteger
}

func validateStringFormat(value string, format string) bool {
	switch format {
	case "hostnameRFC1123":
		return isHostnameRFC1123(value)
	case "hostnameLabel":
		return isHostnameLabel(value)
	default:
		return false
	}
}

func isKnownStringFormat(format string) bool {
	return format == "hostnameRFC1123" || format == "hostnameLabel"
}

func isHostnameRFC1123(value string) bool {
	if value == "" || len(value) > 253 {
		return false
	}

	labels := strings.Split(value, ".")
	if len(labels) == 0 || isAllNumericDottedQuad(labels) {
		return false
	}

	for _, label := range labels {
		if len(label) == 0 || len(label) > 63 {
			return false
		}
		for index := 0; index < len(label); index++ {
			char := label[index]
			if index == 0 || index == len(label)-1 {
				if !isASCIIAlphaNumeric(char) {
					return false
				}
			} else if !isASCIIAlphaNumeric(char) && char != '-' {
				return false
			}
		}
	}
	return true
}

func isAllNumericDottedQuad(labels []string) bool {
	if len(labels) != 4 {
		return false
	}
	for _, label := range labels {
		if label == "" {
			return false
		}
		for index := 0; index < len(label); index++ {
			if label[index] < '0' || label[index] > '9' {
				return false
			}
		}
	}
	return true
}

func isHostnameLabel(value string) bool {
	if value == "" || len(value) > 63 {
		return false
	}
	if value[0] == '-' || value[len(value)-1] == '-' {
		return false
	}

	allNumeric := true
	for index := 0; index < len(value); index++ {
		char := value[index]
		switch {
		case char >= 'a' && char <= 'z':
			allNumeric = false
		case char >= '0' && char <= '9':
		case char == '-':
			allNumeric = false
		default:
			return false
		}
	}
	return !allNumeric
}

func containsInlineSecretMaterial(value string) bool {
	lower := asciiLowercase(value)
	return strings.Contains(lower, "data:") ||
		strings.Contains(lower, "-----begin") ||
		containsLongBase64ishRun(value)
}

func containsLongBase64ishRun(value string) bool {
	runLength := 0
	for index := 0; index < len(value); index++ {
		if isBase64ish(value[index]) {
			runLength++
			if runLength >= 48 {
				return true
			}
		} else {
			runLength = 0
		}
	}
	return false
}

func isBase64ish(char byte) bool {
	return isASCIIAlphaNumeric(char) || char == '+' || char == '/' || char == '_' || char == '-'
}

func asciiLowercase(value string) string {
	var builder strings.Builder
	changed := false
	for index := 0; index < len(value); index++ {
		char := value[index]
		if char >= 'A' && char <= 'Z' {
			if !changed {
				builder.Grow(len(value))
				builder.WriteString(value[:index])
				changed = true
			}
			builder.WriteByte(char + ('a' - 'A'))
		} else if changed {
			builder.WriteByte(char)
		}
	}
	if !changed {
		return value
	}
	return builder.String()
}

func utf16CodeUnitLength(value string) int64 {
	var length int64
	for _, r := range value {
		if r <= 0xffff {
			length++
		} else {
			length += 2
		}
	}
	return length
}

func uniqueValueKey(value capabilityValue) string {
	switch typed := value.(type) {
	case string:
		return "string:" + typed
	case float64:
		if typed == 0 {
			return "number:0"
		}
		return "number:" + strconv.FormatFloat(typed, 'f', 0, 64)
	case bool:
		return "boolean:" + strconv.FormatBool(typed)
	case capabilityArray:
		parts := make([]string, 0, len(typed))
		for _, item := range typed {
			parts = append(parts, uniqueValueKey(item))
		}
		return "a:[" + strings.Join(parts, ",") + "]"
	case capabilityObject:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)

		parts := make([]string, 0, len(keys))
		for _, key := range keys {
			parts = append(parts, key+":"+uniqueValueKey(typed[key]))
		}
		return "o:{" + strings.Join(parts, ",") + "}"
	default:
		return fmt.Sprintf("%T:%v", value, value)
	}
}

func isASCIIAlphaNumeric(char byte) bool {
	return (char >= '0' && char <= '9') ||
		(char >= 'A' && char <= 'Z') ||
		(char >= 'a' && char <= 'z')
}

func cloneInt64Pointer(value *int64) *int64 {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}

func boolPointer(value bool) *bool {
	return &value
}

func joinPath(parent string, child string) string {
	escaped := escapePathToken(child)
	if parent == "" {
		return escaped
	}
	return parent + "/" + escaped
}

func pathError(path string, message string) error {
	if path == "" {
		return errors.New(message)
	}
	return fmt.Errorf("%s: %s", path, message)
}

func escapePathToken(token string) string {
	return strings.ReplaceAll(strings.ReplaceAll(token, "~", "~0"), "/", "~1")
}
