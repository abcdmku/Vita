package capmanifest

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/netip"
	"sort"
	"strconv"
	"strings"
	"time"
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
	UniqueBy        []string
	Fields          map[string]FieldSchema
	CrossFieldRules []CrossFieldRule
}

type CrossFieldRule struct {
	Type    string
	Control string
	Target  string
}

type jsonValue interface{}
type jsonObject map[string]jsonValue
type jsonArray []jsonValue
type jsonString struct {
	value    string
	rawToken string
}

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
	uniqueBy        []string
	fields          map[string]compiledField
	fieldNames      []string
	crossFieldRules []CrossFieldRule
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
		"uniqueBy":    {},
		"uniqueItems": {},
	}
	objectSchemaFields = map[string]struct{}{
		"crossFieldRules": {},
		"fields":          {},
		"required":        {},
		"type":            {},
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

	return applyCrossFieldRules(output, compiled.crossFieldRules, "")
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
	uniqueBy, err := optionalUniqueBy(object, "uniqueBy", joinPath(path, "uniqueBy"))
	if err != nil {
		return FieldSchema{}, err
	}
	if err := validateUniqueByFields(uniqueBy, items, joinPath(path, "uniqueBy")); err != nil {
		return FieldSchema{}, err
	}

	return FieldSchema{
		Type:        "array",
		Required:    required,
		Items:       &items,
		MinItems:    minItems,
		MaxItems:    maxItems,
		UniqueItems: uniqueItems,
		UniqueBy:    uniqueBy,
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

	var rules []CrossFieldRule
	if rulesValue, ok := object["crossFieldRules"]; ok {
		rulesArray, ok := rulesValue.(jsonArray)
		if !ok {
			return FieldSchema{}, pathError(joinPath(path, "crossFieldRules"), "expected cross-field rules array")
		}
		rules, err = parseCrossFieldRules(rulesArray, fields, joinPath(path, "crossFieldRules"))
		if err != nil {
			return FieldSchema{}, err
		}
	}

	return FieldSchema{
		Type:            "object",
		Required:        required,
		Fields:          fields,
		CrossFieldRules: rules,
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
	if field.Minimum != nil || field.Maximum != nil || field.Items != nil || field.MinItems != nil || field.MaxItems != nil || field.UniqueItems || field.UniqueBy != nil || field.Fields != nil || field.CrossFieldRules != nil {
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
	if field.MaxLength != nil || field.Enum != nil || field.Lowercase || field.NoInlineSecrets || field.Format != "" || field.Items != nil || field.MinItems != nil || field.MaxItems != nil || field.UniqueItems || field.UniqueBy != nil || field.Fields != nil || field.CrossFieldRules != nil {
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
	if field.MaxLength != nil || field.Enum != nil || field.Lowercase || field.NoInlineSecrets || field.Format != "" || field.Minimum != nil || field.Maximum != nil || field.Items != nil || field.MinItems != nil || field.MaxItems != nil || field.UniqueItems || field.UniqueBy != nil || field.Fields != nil || field.CrossFieldRules != nil {
		return compiledField{}, pathError(path, "boolean field contains unsupported constraints")
	}

	return compiledField{
		fieldType: "boolean",
		required:  field.Required,
	}, nil
}

func compileArrayFieldSchema(field FieldSchema, path string, depth int, seen map[*FieldSchema]struct{}) (compiledField, error) {
	if field.MaxLength != nil || field.Enum != nil || field.Lowercase || field.NoInlineSecrets || field.Format != "" || field.Minimum != nil || field.Maximum != nil || field.Fields != nil || field.CrossFieldRules != nil {
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
	if err := validateUniqueByFields(field.UniqueBy, *field.Items, joinPath(path, "uniqueBy")); err != nil {
		return compiledField{}, err
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
		uniqueBy:    cloneStrings(field.UniqueBy),
	}, nil
}

func compileObjectFieldSchema(field FieldSchema, path string, depth int, seen map[*FieldSchema]struct{}) (compiledField, error) {
	if field.MaxLength != nil || field.Enum != nil || field.Lowercase || field.NoInlineSecrets || field.Format != "" || field.Minimum != nil || field.Maximum != nil || field.Items != nil || field.MinItems != nil || field.MaxItems != nil || field.UniqueItems || field.UniqueBy != nil {
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

	for index, rule := range field.CrossFieldRules {
		rulePath := joinPath(joinPath(path, "crossFieldRules"), strconv.Itoa(index))
		if rule.Type != "requireNonEmptyArrayWhenTrue" && rule.Type != "requireEmptyArrayWhenFalse" {
			return compiledField{}, pathError(joinPath(rulePath, "type"), "unknown cross-field rule type")
		}
		controlField, ok := fields[rule.Control]
		if !ok || controlField.fieldType != "boolean" {
			return compiledField{}, pathError(joinPath(rulePath, "control"), "control field must reference a boolean field")
		}
		targetField, ok := fields[rule.Target]
		if !ok || targetField.fieldType != "array" {
			return compiledField{}, pathError(joinPath(rulePath, "target"), "target field must reference an array field")
		}
	}

	return compiledField{
		fieldType:       "object",
		required:        field.Required,
		fieldNames:      fieldNames,
		fields:          fields,
		crossFieldRules: append([]CrossFieldRule(nil), field.CrossFieldRules...),
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
	raw, ok := asJSONString(value)
	if !ok {
		return nil, pathError(path, "expected string")
	}
	if field.noInlineSecrets && containsInlineSecretMaterial(raw.value) {
		return nil, pathError(path, "inline secret material is not allowed")
	}

	normalized := raw.value
	if field.format != "" {
		formatted, ok := normalizeStringFormat(raw.value, field.format, raw.rawToken)
		if !ok {
			return nil, pathError(path, "string does not match required format")
		}
		normalized = formatted
	}

	if field.lowercase {
		normalized = asciiLowercase(normalized)
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
	seenItems := map[string]int{}
	seenUniqueBy := map[string]int{}
	for index, item := range array {
		itemPath := joinPath(path, strconv.Itoa(index))
		normalized, err := validateField(item, *field.items, itemPath)
		if err != nil {
			return nil, err
		}
		if field.uniqueItems {
			key := uniqueValueKey(normalized)
			if previous, ok := seenItems[key]; ok {
				return nil, pathError(itemPath, fmt.Sprintf("duplicate array item also appears at %s", joinPath(path, strconv.Itoa(previous))))
			}
			seenItems[key] = index
		}
		if len(field.uniqueBy) > 0 {
			key, err := uniqueByValueKey(normalized, field.uniqueBy, itemPath)
			if err != nil {
				return nil, err
			}
			if previous, ok := seenUniqueBy[key]; ok {
				return nil, pathError(itemPath, fmt.Sprintf("duplicate array item key also appears at %s", joinPath(path, strconv.Itoa(previous))))
			}
			seenUniqueBy[key] = index
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
	if err := applyCrossFieldRules(output, field.crossFieldRules, path); err != nil {
		return nil, err
	}
	return output, nil
}

func applyCrossFieldRules(value map[string]capabilityValue, rules []CrossFieldRule, path string) error {
	for _, rule := range rules {
		controlValue, hasControl := value[rule.Control]
		targetValue, hasTarget := value[rule.Target]
		targetPath := joinPath(path, rule.Target)
		if !hasControl || !hasTarget {
			return pathError(targetPath, "cross-field rule references invalid fields")
		}
		control, ok := controlValue.(bool)
		if !ok {
			return pathError(targetPath, "cross-field rule references invalid fields")
		}
		target, ok := targetValue.(capabilityArray)
		if !ok {
			return pathError(targetPath, "cross-field rule references invalid fields")
		}

		switch rule.Type {
		case "requireNonEmptyArrayWhenTrue":
			if control && len(target) == 0 {
				return pathError(targetPath, fmt.Sprintf("%s must be non-empty when %s is true", rule.Target, rule.Control))
			}
		case "requireEmptyArrayWhenFalse":
			if !control && len(target) != 0 {
				return pathError(targetPath, fmt.Sprintf("%s must be empty when %s is false", rule.Target, rule.Control))
			}
		default:
			return pathError(targetPath, "unknown cross-field rule type")
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
	value, err := parseJSONValue(decoder, raw, 0, &nodes)
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

func parseJSONValue(decoder *json.Decoder, raw []byte, depth int, nodes *int) (jsonValue, error) {
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
				child, err := parseJSONValue(decoder, raw, depth+1, nodes)
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
				child, err := parseJSONValue(decoder, raw, depth+1, nodes)
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
	case string:
		rawToken, err := rawJSONStringToken(raw, decoder.InputOffset())
		if err != nil {
			return nil, err
		}
		return jsonString{value: value, rawToken: rawToken}, nil
	case bool, json.Number:
		return value, nil
	default:
		return nil, fmt.Errorf("unsupported JSON token %T", token)
	}
}

func rawJSONStringToken(raw []byte, endOffset int64) (string, error) {
	end := int(endOffset)
	if end < 2 || end > len(raw) || raw[end-1] != '"' {
		return "", errors.New("string token offset is invalid")
	}

	for start := end - 2; start >= 0; start-- {
		if raw[start] != '"' {
			continue
		}

		backslashes := 0
		for index := start - 1; index >= 0 && raw[index] == '\\'; index-- {
			backslashes++
		}
		if backslashes%2 == 0 {
			return string(raw[start+1 : end-1]), nil
		}
	}

	return "", errors.New("string token start not found")
}

func asJSONString(value jsonValue) (jsonString, bool) {
	switch typed := value.(type) {
	case jsonString:
		return typed, true
	case string:
		return jsonString{value: typed, rawToken: typed}, true
	default:
		return jsonString{}, false
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
	stringValue, ok := asJSONString(value)
	if !ok {
		return "", pathError(path, "expected string")
	}
	return stringValue.value, nil
}

func optionalString(object jsonObject, key string, path string) (string, error) {
	value, ok := object[key]
	if !ok {
		return "", nil
	}
	stringValue, ok := asJSONString(value)
	if !ok {
		return "", pathError(path, "expected string")
	}
	return stringValue.value, nil
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
		stringValue, ok := asJSONString(item)
		if !ok {
			return nil, pathError(joinPath(path, strconv.Itoa(index)), "expected string enum value")
		}
		if _, exists := seen[stringValue.value]; exists {
			return nil, pathError(joinPath(path, strconv.Itoa(index)), "duplicate enum value")
		}
		seen[stringValue.value] = struct{}{}
		values = append(values, stringValue.value)
	}
	return values, nil
}

func optionalUniqueBy(object jsonObject, key string, path string) ([]string, error) {
	value, ok := object[key]
	if !ok {
		return nil, nil
	}
	array, ok := value.(jsonArray)
	if !ok || len(array) == 0 {
		return nil, pathError(path, "expected non-empty uniqueBy field array")
	}

	seen := map[string]struct{}{}
	values := make([]string, 0, len(array))
	for index, item := range array {
		stringValue, ok := asJSONString(item)
		if !ok || stringValue.value == "" {
			return nil, pathError(joinPath(path, strconv.Itoa(index)), "expected non-empty uniqueBy field name")
		}
		if _, exists := seen[stringValue.value]; exists {
			return nil, pathError(joinPath(path, strconv.Itoa(index)), "duplicate uniqueBy field name")
		}
		seen[stringValue.value] = struct{}{}
		values = append(values, stringValue.value)
	}
	return values, nil
}

func validateUniqueByFields(uniqueBy []string, items FieldSchema, path string) error {
	if uniqueBy == nil {
		return nil
	}
	if len(uniqueBy) == 0 {
		return pathError(path, "expected non-empty uniqueBy field array")
	}
	if items.Type != "object" || items.Fields == nil {
		return pathError(path, "uniqueBy requires object array items")
	}
	seen := map[string]struct{}{}
	for index, name := range uniqueBy {
		if name == "" {
			return pathError(joinPath(path, strconv.Itoa(index)), "expected non-empty uniqueBy field name")
		}
		if _, exists := seen[name]; exists {
			return pathError(joinPath(path, strconv.Itoa(index)), "duplicate uniqueBy field name")
		}
		seen[name] = struct{}{}
		field, ok := items.Fields[name]
		if !ok {
			return pathError(joinPath(path, strconv.Itoa(index)), "uniqueBy field must reference an item object field")
		}
		if !field.Required {
			return pathError(joinPath(path, strconv.Itoa(index)), "uniqueBy field must reference a required item field")
		}
	}
	return nil
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

func normalizeStringFormat(value string, format string, rawToken ...string) (string, bool) {
	switch format {
	case "hostnameRFC1123":
		if isHostnameRFC1123(value) {
			return value, true
		}
		return "", false
	case "hostnameLabel":
		if isHostnameLabel(value) {
			return value, true
		}
		return "", false
	case "ipLiteral":
		return canonicalizeIPLiteral(value)
	case "hostnameOrIp":
		if ip, ok := canonicalizeIPLiteral(value); ok {
			return ip, true
		}
		if isAgentHostname(value) {
			return strings.ToLower(value), true
		}
		return "", false
	case "posixUsername", "groupName":
		if isPOSIXName(value) {
			return value, true
		}
		return "", false
	case "systemdUnitName":
		if isSystemdUnitName(value) {
			return value, true
		}
		return "", false
	case "absolutePath":
		if isCanonicalAbsolutePath(value) {
			return value, true
		}
		return "", false
	case "rfc3339Instant":
		token := value
		if len(rawToken) > 0 {
			token = rawToken[0]
		}
		if strings.Contains(token, "\\") {
			return "", false
		}
		parsed, err := time.Parse(time.RFC3339, token)
		if err != nil || parsed.IsZero() {
			return "", false
		}
		return value, true
	default:
		return "", false
	}
}

func isKnownStringFormat(format string) bool {
	return format == "hostnameRFC1123" ||
		format == "hostnameLabel" ||
		format == "ipLiteral" ||
		format == "hostnameOrIp" ||
		format == "posixUsername" ||
		format == "groupName" ||
		format == "systemdUnitName" ||
		format == "absolutePath" ||
		format == "rfc3339Instant"
}

func isPOSIXName(value string) bool {
	if len(value) == 0 || len(value) > 32 {
		return false
	}
	if !isASCIILowercase(value[0]) && value[0] != '_' {
		return false
	}
	for index := 1; index < len(value); index++ {
		char := value[index]
		if !isASCIILowercase(char) && !isASCIIDigit(char) && char != '_' && char != '-' {
			return false
		}
	}
	return true
}

const maxSystemdUnitNameLength = 256

var (
	systemdUnitSuffixes = []string{
		".service",
		".socket",
		".device",
		".mount",
		".automount",
		".swap",
		".target",
		".path",
		".timer",
		".slice",
		".scope",
	}
	forbiddenInlineReferenceSchemes = []string{"data", "inline", "literal"}
	servicePrivateMaterialTokens    = []string{
		"privatekey",
		"private-key",
		"private_key",
		"opensshprivatekey",
		"opensshprivate-key",
		"opensshprivate_key",
		"openssh-privatekey",
		"openssh-private-key",
		"openssh-private_key",
		"openssh_privatekey",
		"openssh_private-key",
		"openssh_private_key",
		"agesecretkey",
		"agesecret-key",
		"agesecret_key",
		"age-secretkey",
		"age-secret-key",
		"age-secret_key",
		"age_secretkey",
		"age_secret-key",
		"age_secret_key",
		"xprv",
		"seedphrase",
		"seed-phrase",
		"seed_phrase",
		"mnemonic",
		"recoveryphrase",
		"recovery-phrase",
		"recovery_phrase",
	}
	serviceSecretAssignmentTokens = []string{
		"privatekey",
		"private-key",
		"private_key",
		"apikey",
		"api-key",
		"api_key",
		"accesstoken",
		"access-token",
		"access_token",
		"refreshtoken",
		"refresh-token",
		"refresh_token",
		"password",
		"secret",
	}
)

func isSystemdUnitName(value string) bool {
	if value == "" ||
		len(value) > maxSystemdUnitNameLength ||
		value[0] == '.' ||
		strings.Contains(value, "..") ||
		hasInlineReferenceScheme(value) ||
		containsInlineServiceMaterial(value) {
		return false
	}

	for index := 0; index < len(value); index++ {
		if !isSystemdUnitNameChar(value[index]) {
			return false
		}
	}

	prefix, ok := systemdUnitPrefix(value)
	if !ok || prefix == "" || strings.HasPrefix(prefix, ".") {
		return false
	}

	for index := 0; index < len(prefix); index++ {
		if !isSystemdUnitNameChar(prefix[index]) {
			return false
		}
	}

	return true
}

func systemdUnitPrefix(value string) (string, bool) {
	for _, suffix := range systemdUnitSuffixes {
		if strings.HasSuffix(value, suffix) {
			return strings.TrimSuffix(value, suffix), true
		}
	}
	return "", false
}

func hasInlineReferenceScheme(value string) bool {
	colon := strings.IndexByte(value, ':')
	if colon <= 0 {
		return false
	}
	scheme := asciiLowercase(value[:colon])
	for _, forbidden := range forbiddenInlineReferenceSchemes {
		if scheme == forbidden {
			return true
		}
	}
	return false
}

func containsInlineServiceMaterial(value string) bool {
	lower := asciiLowercase(value)
	if strings.Contains(lower, "-----begin") || containsLongHexRun(value) || containsLongBase64Run(value) {
		return true
	}
	for _, token := range servicePrivateMaterialTokens {
		if containsBoundedToken(lower, token) {
			return true
		}
	}
	for _, token := range serviceSecretAssignmentTokens {
		if containsSecretAssignmentToken(lower, token) {
			return true
		}
	}
	return false
}

func containsBoundedToken(value string, token string) bool {
	for start := strings.Index(value, token); start != -1; start = nextStringIndex(value, token, start+1) {
		afterIndex := start + len(token)
		beforeOK := start == 0 || !isASCIIRegexWord(value[start-1])
		afterOK := afterIndex >= len(value) || !isASCIIRegexWord(value[afterIndex])
		if beforeOK && afterOK {
			return true
		}
	}
	return false
}

func containsSecretAssignmentToken(value string, token string) bool {
	for start := strings.Index(value, token); start != -1; start = nextStringIndex(value, token, start+1) {
		if start != 0 && isASCIIRegexWord(value[start-1]) {
			continue
		}

		afterIndex := start + len(token)
		for afterIndex < len(value) && isASCIIWhitespace(value[afterIndex]) {
			afterIndex++
		}
		if afterIndex < len(value) && (value[afterIndex] == ':' || value[afterIndex] == '=') {
			return true
		}
	}
	return false
}

func nextStringIndex(value string, token string, offset int) int {
	next := strings.Index(value[offset:], token)
	if next == -1 {
		return -1
	}
	return offset + next
}

func containsLongHexRun(value string) bool {
	runLength := 0
	for index := 0; index < len(value); index++ {
		if isASCIIHex(value[index]) {
			runLength++
			if runLength >= 32 {
				return true
			}
		} else {
			runLength = 0
		}
	}
	return false
}

func containsLongBase64Run(value string) bool {
	standardRunLength := 0
	urlRunLength := 0
	for index := 0; index < len(value); index++ {
		char := value[index]
		if isASCIIAlphaNumeric(char) || char == '+' || char == '/' {
			standardRunLength++
			if standardRunLength >= 48 {
				return true
			}
		} else {
			standardRunLength = 0
		}
		if isASCIIAlphaNumeric(char) || char == '_' || char == '-' {
			urlRunLength++
			if urlRunLength >= 48 {
				return true
			}
		} else {
			urlRunLength = 0
		}
	}
	return false
}

func isCanonicalAbsolutePath(value string) bool {
	if !strings.HasPrefix(value, "/") || value == "/" || strings.HasSuffix(value, "/") {
		return false
	}

	segments := strings.Split(value, "/")
	for index := 1; index < len(segments); index++ {
		segment := segments[index]
		if segment == "" || segment == "." || segment == ".." || strings.ContainsRune(segment, '\x00') {
			return false
		}
	}
	return true
}

func canonicalizeIPLiteral(value string) (string, bool) {
	if value == "" || strings.Contains(value, "%") {
		return "", false
	}

	addr, err := netip.ParseAddr(value)
	if err != nil {
		return "", false
	}

	return addr.String(), true
}

func isAgentHostname(value string) bool {
	if value == "" ||
		len(value) > 253 ||
		value != strings.TrimSpace(value) ||
		strings.HasSuffix(value, ".") ||
		strings.Contains(value, "..") ||
		strings.ContainsAny(value, ":/?#[]@") ||
		containsControlCharacter(value) {
		return false
	}

	labels := strings.Split(value, ".")
	for _, label := range labels {
		if !isAgentHostnameLabel(label) {
			return false
		}
	}
	return true
}

func isAgentHostnameLabel(value string) bool {
	if len(value) == 0 || len(value) > 63 {
		return false
	}
	for index := 0; index < len(value); index++ {
		char := value[index]
		if index == 0 || index == len(value)-1 {
			if !isASCIIAlphaNumeric(char) {
				return false
			}
		} else if !isASCIIAlphaNumeric(char) && char != '-' {
			return false
		}
	}
	return true
}

func containsControlCharacter(value string) bool {
	for index := 0; index < len(value); index++ {
		char := value[index]
		if char <= 0x1f || char == 0x7f {
			return true
		}
	}
	return false
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

func uniqueByValueKey(value capabilityValue, uniqueBy []string, path string) (string, error) {
	object, ok := value.(capabilityObject)
	if !ok {
		return "", pathError(path, "uniqueBy requires object array items with all key fields present")
	}

	parts := make([]string, 0, len(uniqueBy))
	for _, fieldName := range uniqueBy {
		item, ok := object[fieldName]
		if !ok {
			return "", pathError(path, "uniqueBy requires object array items with all key fields present")
		}
		parts = append(parts, fieldName+":"+uniqueValueKey(item))
	}
	return "o:{" + strings.Join(parts, ",") + "}", nil
}

func isASCIIAlphaNumeric(char byte) bool {
	return (char >= '0' && char <= '9') ||
		(char >= 'A' && char <= 'Z') ||
		(char >= 'a' && char <= 'z')
}

func isASCIILowercase(char byte) bool {
	return char >= 'a' && char <= 'z'
}

func isASCIIDigit(char byte) bool {
	return char >= '0' && char <= '9'
}

func isASCIIHex(char byte) bool {
	return (char >= '0' && char <= '9') ||
		(char >= 'A' && char <= 'F') ||
		(char >= 'a' && char <= 'f')
}

func isASCIIRegexWord(char byte) bool {
	return isASCIIAlphaNumeric(char) || char == '_'
}

func isASCIIWhitespace(char byte) bool {
	return char == '\t' || char == '\n' || char == '\v' || char == '\f' || char == '\r' || char == ' '
}

func isSystemdUnitNameChar(char byte) bool {
	return isASCIIAlphaNumeric(char) || char == ':' || char == '.' || char == '_' || char == '@' || char == '-'
}

func cloneInt64Pointer(value *int64) *int64 {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}

func cloneStrings(value []string) []string {
	if value == nil {
		return nil
	}
	cloned := make([]string, len(value))
	copy(cloned, value)
	return cloned
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
