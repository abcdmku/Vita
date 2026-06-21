package capmanifest

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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
	Type                     string
	Required                 bool
	MaxLength                *int64
	MaxBytes                 *int64
	MinLength                *int64
	Enum                     []string
	NotInEnum                []string
	Lowercase                bool
	NoControlChars           bool
	NoInlineCapsuleMaterial  bool
	NoInlineIdentityMaterial bool
	NoInlineMaterial         bool
	NoInlineSecrets          bool
	NonEmpty                 bool
	Trimmed                  bool
	ForbiddenSchemePrefix    bool
	Format                   string
	Minimum                  *int64
	Maximum                  *int64
	SentinelValues           []int64
	Items                    *FieldSchema
	MinItems                 *int64
	MaxItems                 *int64
	UniqueItems              bool
	DedupItems               bool
	UniqueBy                 []string
	SingletonEnumValues      *EnumValuesRule
	RequiredEnumValues       *EnumValuesRule
	UniqueByWhenEnum         *UniqueByWhenEnumRule
	Fields                   map[string]FieldSchema
	CrossFieldRules          []CrossFieldRule
	// NullAsAbsent: on an OPTIONAL string/integer field, an explicit JSON null is treated as ABSENT
	// (skipped, not type-checked, not counted by exactlyOneOf). Mirrors the agent's omitempty pointer
	// fields (e.g. backup Schedule.Cron *string), where encoding/json decodes null→nil→absent. Opt-in.
	NullAsAbsent bool
}

type CrossFieldRule struct {
	Type      string
	Control   string
	Target    string
	Integer   string
	Sentinel  *int64
	Fields    []string
	EnumField string
	EnumValue string
	HasEnum   bool
	Field     string
}

// EnumValuesRule is an enum-discriminated whole-list invariant: it selects array items by the value
// of an enum-typed string field (Field) on each item object and asserts a property over the matched
// subset. Used by SingletonEnumValues (each listed value at most once) and RequiredEnumValues (every
// listed value at least once). Mirrors storage normalizeLayout singletonRoles/requiredRoles.
type EnumValuesRule struct {
	Field  string
	Values []string
}

// UniqueByWhenEnumRule is a filtered uniqueBy: among ONLY the items whose Field equals Value, the
// UniqueBy key tuple must be unique. Mirrors storage seenAppIDs (appId unique among app-state rows).
type UniqueByWhenEnumRule struct {
	Field    string
	Value    string
	UniqueBy []string
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
	fieldType                string
	required                 bool
	maxLength                *int64
	maxBytes                 *int64
	minLength                *int64
	enumValues               map[string]struct{}
	notInEnumValues          map[string]struct{}
	lowercase                bool
	noControlChars           bool
	noInlineCapsuleMaterial  bool
	noInlineIdentityMaterial bool
	noInlineMaterial         bool
	forbiddenSchemePrefix    bool
	trimmed                  bool
	format                   string
	minimum                  *int64
	maximum                  *int64
	sentinelValues           map[int64]struct{}
	items                    *compiledField
	minItems                 *int64
	maxItems                 *int64
	uniqueItems              bool
	dedupItems               bool
	uniqueBy                 []string
	singletonEnumValues      *compiledEnumValuesRule
	requiredEnumValues       *compiledEnumValuesRule
	uniqueByWhenEnum         *compiledUniqueByWhenEnumRule
	fields                   map[string]compiledField
	fieldNames               []string
	crossFieldRules          []CrossFieldRule
	nullAsAbsent             bool
}

type compiledEnumValuesRule struct {
	field  string
	values map[string]struct{}
	order  []string
}

type compiledUniqueByWhenEnumRule struct {
	field    string
	value    string
	uniqueBy []string
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
		"enum":                     {},
		"format":                   {},
		"lowercase":                {},
		"maxBytes":                 {},
		"maxLength":                {},
		"minLength":                {},
		"notInEnum":                {},
		"forbiddenSchemePrefix":    {},
		"noInlineCapsuleMaterial":  {},
		"noControlChars":           {},
		"noInlineIdentityMaterial": {},
		"noInlineMaterial":         {},
		"noInlineSecrets":          {},
		"nonEmpty":                 {},
		"nullAsAbsent":             {},
		"required":                 {},
		"trimmed":                  {},
		"type":                     {},
	}
	integerSchemaFields = map[string]struct{}{
		"maximum":        {},
		"minimum":        {},
		"nullAsAbsent":   {},
		"required":       {},
		"sentinelValues": {},
		"type":           {},
	}
	booleanSchemaFields = map[string]struct{}{
		"required": {},
		"type":     {},
	}
	arraySchemaFields = map[string]struct{}{
		"items":               {},
		"dedupItems":          {},
		"maxItems":            {},
		"minItems":            {},
		"required":            {},
		"requiredEnumValues":  {},
		"singletonEnumValues": {},
		"type":                {},
		"uniqueBy":            {},
		"uniqueByWhenEnum":    {},
		"uniqueItems":         {},
	}
	objectSchemaFields = map[string]struct{}{
		"crossFieldRules": {},
		"fields":          {},
		"required":        {},
		"type":            {},
	}
	crossFieldRuleFields = map[string]struct{}{
		"control":   {},
		"enumField": {},
		"enumValue": {},
		"field":     {},
		"fields":    {},
		"integer":   {},
		"sentinel":  {},
		"target":    {},
		"type":      {},
	}
	singletonEnumValuesFields = map[string]struct{}{
		"field":  {},
		"values": {},
	}
	requiredEnumValuesFields = map[string]struct{}{
		"field":  {},
		"values": {},
	}
	uniqueByWhenEnumFields = map[string]struct{}{
		"field":    {},
		"uniqueBy": {},
		"value":    {},
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
		if fieldNullCountsAsAbsent(field, raw) {
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
	maxBytes, err := optionalSafeInteger(object, "maxBytes", joinPath(path, "maxBytes"), 0, maxSafeInteger)
	if err != nil {
		return FieldSchema{}, err
	}
	minLength, err := optionalSafeInteger(object, "minLength", joinPath(path, "minLength"), 0, maxSafeInteger)
	if err != nil {
		return FieldSchema{}, err
	}
	enumValues, err := optionalStringEnum(object, "enum", joinPath(path, "enum"))
	if err != nil {
		return FieldSchema{}, err
	}
	notInEnumValues, err := optionalStringEnum(object, "notInEnum", joinPath(path, "notInEnum"))
	if err != nil {
		return FieldSchema{}, err
	}
	lowercase, err := optionalBool(object, "lowercase", joinPath(path, "lowercase"))
	if err != nil {
		return FieldSchema{}, err
	}
	noControlChars, err := optionalBool(object, "noControlChars", joinPath(path, "noControlChars"))
	if err != nil {
		return FieldSchema{}, err
	}
	noInlineCapsuleMaterial, err := optionalBool(object, "noInlineCapsuleMaterial", joinPath(path, "noInlineCapsuleMaterial"))
	if err != nil {
		return FieldSchema{}, err
	}
	noInlineIdentityMaterial, err := optionalBool(object, "noInlineIdentityMaterial", joinPath(path, "noInlineIdentityMaterial"))
	if err != nil {
		return FieldSchema{}, err
	}
	noInlineMaterial, err := optionalBool(object, "noInlineMaterial", joinPath(path, "noInlineMaterial"))
	if err != nil {
		return FieldSchema{}, err
	}
	noInlineSecrets, err := optionalBool(object, "noInlineSecrets", joinPath(path, "noInlineSecrets"))
	if err != nil {
		return FieldSchema{}, err
	}
	nonEmpty, err := optionalBool(object, "nonEmpty", joinPath(path, "nonEmpty"))
	if err != nil {
		return FieldSchema{}, err
	}
	trimmed, err := optionalBool(object, "trimmed", joinPath(path, "trimmed"))
	if err != nil {
		return FieldSchema{}, err
	}
	forbiddenSchemePrefix, err := optionalBool(object, "forbiddenSchemePrefix", joinPath(path, "forbiddenSchemePrefix"))
	if err != nil {
		return FieldSchema{}, err
	}
	nullAsAbsent, err := optionalBool(object, "nullAsAbsent", joinPath(path, "nullAsAbsent"))
	if err != nil {
		return FieldSchema{}, err
	}

	return FieldSchema{
		Type:                     "string",
		Required:                 required,
		MaxLength:                maxLength,
		MaxBytes:                 maxBytes,
		MinLength:                minLength,
		Enum:                     enumValues,
		NotInEnum:                notInEnumValues,
		Lowercase:                lowercase,
		NoControlChars:           noControlChars,
		NoInlineCapsuleMaterial:  noInlineCapsuleMaterial,
		NoInlineIdentityMaterial: noInlineIdentityMaterial,
		NoInlineMaterial:         noInlineMaterial,
		NoInlineSecrets:          noInlineSecrets,
		NonEmpty:                 nonEmpty,
		Trimmed:                  trimmed,
		ForbiddenSchemePrefix:    forbiddenSchemePrefix,
		Format:                   format,
		NullAsAbsent:             nullAsAbsent,
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
	sentinelValues, err := optionalSafeIntegerArray(object, "sentinelValues", joinPath(path, "sentinelValues"), -maxSafeInteger, maxSafeInteger)
	if err != nil {
		return FieldSchema{}, err
	}
	nullAsAbsent, err := optionalBool(object, "nullAsAbsent", joinPath(path, "nullAsAbsent"))
	if err != nil {
		return FieldSchema{}, err
	}
	if minimum != nil && maximum != nil && *minimum > *maximum {
		return FieldSchema{}, pathError(path, "minimum must be less than or equal to maximum")
	}

	return FieldSchema{
		Type:           "integer",
		Required:       required,
		Minimum:        minimum,
		Maximum:        maximum,
		SentinelValues: sentinelValues,
		NullAsAbsent:   nullAsAbsent,
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
	dedupItems, err := optionalBool(object, "dedupItems", joinPath(path, "dedupItems"))
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
	singletonEnumValues, err := parseEnumValuesRule(object, "singletonEnumValues", singletonEnumValuesFields, items, joinPath(path, "singletonEnumValues"))
	if err != nil {
		return FieldSchema{}, err
	}
	requiredEnumValues, err := parseEnumValuesRule(object, "requiredEnumValues", requiredEnumValuesFields, items, joinPath(path, "requiredEnumValues"))
	if err != nil {
		return FieldSchema{}, err
	}
	uniqueByWhenEnum, err := parseUniqueByWhenEnumRule(object, "uniqueByWhenEnum", items, joinPath(path, "uniqueByWhenEnum"))
	if err != nil {
		return FieldSchema{}, err
	}

	return FieldSchema{
		Type:                "array",
		Required:            required,
		Items:               &items,
		MinItems:            minItems,
		MaxItems:            maxItems,
		UniqueItems:         uniqueItems,
		DedupItems:          dedupItems,
		UniqueBy:            uniqueBy,
		SingletonEnumValues: singletonEnumValues,
		RequiredEnumValues:  requiredEnumValues,
		UniqueByWhenEnum:    uniqueByWhenEnum,
	}, nil
}

// parseEnumValuesRule parses a singletonEnumValues/requiredEnumValues rule object: { field, values }.
// Field must reference a required enum-string item field, and every listed value must be a member of
// that enum (the governed, closed dialect fixes the discriminator + values at load time).
func parseEnumValuesRule(object jsonObject, key string, allowed map[string]struct{}, items FieldSchema, path string) (*EnumValuesRule, error) {
	value, ok := object[key]
	if !ok {
		return nil, nil
	}
	ruleObject, ok := value.(jsonObject)
	if !ok {
		return nil, pathError(path, "expected "+key+" object")
	}
	if err := rejectUnknownFields(ruleObject, allowed, path); err != nil {
		return nil, err
	}
	field, err := requiredString(ruleObject, "field", joinPath(path, "field"))
	if err != nil {
		return nil, err
	}
	values, err := enumValueList(ruleObject, "values", joinPath(path, "values"))
	if err != nil {
		return nil, err
	}
	if err := validateEnumDiscriminatorField(items, field, values, path); err != nil {
		return nil, err
	}
	return &EnumValuesRule{Field: field, Values: values}, nil
}

// parseUniqueByWhenEnumRule parses { field, value, uniqueBy }: a filtered uniqueBy over the subset of
// items whose enum field equals value. The keyed fields need only EXIST on the item object (they are
// guaranteed present for matched items by the conditional-presence cross-field rule), so they need
// not be globally required.
func parseUniqueByWhenEnumRule(object jsonObject, key string, items FieldSchema, path string) (*UniqueByWhenEnumRule, error) {
	value, ok := object[key]
	if !ok {
		return nil, nil
	}
	ruleObject, ok := value.(jsonObject)
	if !ok {
		return nil, pathError(path, "expected "+key+" object")
	}
	if err := rejectUnknownFields(ruleObject, uniqueByWhenEnumFields, path); err != nil {
		return nil, err
	}
	field, err := requiredString(ruleObject, "field", joinPath(path, "field"))
	if err != nil {
		return nil, err
	}
	enumValue, err := requiredString(ruleObject, "value", joinPath(path, "value"))
	if err != nil {
		return nil, err
	}
	uniqueBy, err := optionalUniqueBy(ruleObject, "uniqueBy", joinPath(path, "uniqueBy"))
	if err != nil {
		return nil, err
	}
	if len(uniqueBy) == 0 {
		return nil, pathError(joinPath(path, "uniqueBy"), "expected non-empty uniqueBy array")
	}
	if err := validateEnumDiscriminatorField(items, field, []string{enumValue}, path); err != nil {
		return nil, err
	}
	if err := validateUniqueByFieldsAllowOptional(uniqueBy, items, joinPath(path, "uniqueBy")); err != nil {
		return nil, err
	}
	return &UniqueByWhenEnumRule{Field: field, Value: enumValue, UniqueBy: uniqueBy}, nil
}

func enumValueList(object jsonObject, key string, path string) ([]string, error) {
	value, ok := object[key]
	if !ok {
		return nil, pathError(path, "expected non-empty values array")
	}
	array, ok := value.(jsonArray)
	if !ok || len(array) == 0 {
		return nil, pathError(path, "expected non-empty values array")
	}
	seen := map[string]struct{}{}
	values := make([]string, 0, len(array))
	for index, item := range array {
		stringValue, ok := asJSONString(item)
		if !ok || stringValue.value == "" {
			return nil, pathError(joinPath(path, strconv.Itoa(index)), "expected non-empty enum value")
		}
		if _, exists := seen[stringValue.value]; exists {
			return nil, pathError(joinPath(path, strconv.Itoa(index)), "duplicate enum value")
		}
		seen[stringValue.value] = struct{}{}
		values = append(values, stringValue.value)
	}
	return values, nil
}

func validateEnumDiscriminatorField(items FieldSchema, field string, values []string, path string) error {
	if items.Type != "object" {
		return pathError(path, "enum-discriminated rule requires object array items")
	}
	discriminator, ok := items.Fields[field]
	if !ok {
		return pathError(joinPath(path, "field"), "field must reference an item object field")
	}
	if discriminator.Type != "string" || !discriminator.Required || len(discriminator.Enum) == 0 {
		return pathError(joinPath(path, "field"), "field must reference a required enum string item field")
	}
	enumSet := map[string]struct{}{}
	for _, value := range discriminator.Enum {
		enumSet[value] = struct{}{}
	}
	for index, value := range values {
		if _, ok := enumSet[value]; !ok {
			return pathError(joinPath(joinPath(path, "values"), strconv.Itoa(index)), "value must be a member of the discriminator enum")
		}
	}
	return nil
}

func validateUniqueByFieldsAllowOptional(uniqueBy []string, items FieldSchema, path string) error {
	if len(uniqueBy) == 0 {
		return nil
	}
	if items.Type != "object" {
		return pathError(path, "uniqueBy requires object array items")
	}
	for index, name := range uniqueBy {
		if _, ok := items.Fields[name]; !ok {
			return pathError(joinPath(path, strconv.Itoa(index)), "uniqueBy field must reference an item object field")
		}
	}
	return nil
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
	_, hasControl := object["control"]
	_, hasTarget := object["target"]
	integer, err := optionalString(object, "integer", joinPath(path, "integer"))
	if err != nil {
		return CrossFieldRule{}, err
	}
	_, hasInteger := object["integer"]
	sentinel, err := optionalSafeInteger(object, "sentinel", joinPath(path, "sentinel"), -maxSafeInteger, maxSafeInteger)
	if err != nil {
		return CrossFieldRule{}, err
	}
	_, hasSentinel := object["sentinel"]
	exactlyOneOfFields, err := optionalCrossFieldFieldList(object, "fields", joinPath(path, "fields"))
	if err != nil {
		return CrossFieldRule{}, err
	}
	_, hasFields := object["fields"]
	enumField, err := optionalString(object, "enumField", joinPath(path, "enumField"))
	if err != nil {
		return CrossFieldRule{}, err
	}
	_, hasEnumField := object["enumField"]
	enumValue, err := optionalString(object, "enumValue", joinPath(path, "enumValue"))
	if err != nil {
		return CrossFieldRule{}, err
	}
	_, hasEnumValue := object["enumValue"]
	conditionalField, err := optionalString(object, "field", joinPath(path, "field"))
	if err != nil {
		return CrossFieldRule{}, err
	}
	_, hasField := object["field"]

	if ruleType != "exactlyOneOf" && hasFields {
		return CrossFieldRule{}, pathError(joinPath(path, "fields"), "fields is not supported by this cross-field rule")
	}

	if ruleType != "requireFieldWhenEnumEquals" && (hasEnumField || hasEnumValue || hasField) {
		return CrossFieldRule{}, pathError(path, "enumField/enumValue/field are not supported by this cross-field rule")
	}

	switch ruleType {
	case "exactlyOneOf":
		if hasControl {
			return CrossFieldRule{}, pathError(joinPath(path, "control"), "control is not supported by this cross-field rule")
		}
		if hasTarget {
			return CrossFieldRule{}, pathError(joinPath(path, "target"), "target is not supported by this cross-field rule")
		}
		if hasInteger {
			return CrossFieldRule{}, pathError(joinPath(path, "integer"), "integer is not supported by this cross-field rule")
		}
		if hasSentinel {
			return CrossFieldRule{}, pathError(joinPath(path, "sentinel"), "sentinel is not supported by this cross-field rule")
		}
		if err := validateCrossFieldExactlyOneOf(fields, exactlyOneOfFields, joinPath(path, "fields")); err != nil {
			return CrossFieldRule{}, err
		}
		return CrossFieldRule{
			Type:   ruleType,
			Fields: cloneStrings(exactlyOneOfFields),
		}, nil
	case "requireNonEmptyArrayWhenTrue", "requireEmptyArrayWhenFalse":
		control, err := requiredString(object, "control", joinPath(path, "control"))
		if err != nil {
			return CrossFieldRule{}, err
		}
		target, err := requiredString(object, "target", joinPath(path, "target"))
		if err != nil {
			return CrossFieldRule{}, err
		}
		if hasInteger {
			return CrossFieldRule{}, pathError(joinPath(path, "integer"), "integer is not supported by this cross-field rule")
		}
		if hasSentinel {
			return CrossFieldRule{}, pathError(joinPath(path, "sentinel"), "sentinel is not supported by this cross-field rule")
		}
		if err := validateCrossFieldBooleanControl(fields, control, joinPath(path, "control")); err != nil {
			return CrossFieldRule{}, err
		}
		if err := validateCrossFieldArrayTarget(fields, target, joinPath(path, "target")); err != nil {
			return CrossFieldRule{}, err
		}
		return CrossFieldRule{
			Type:    ruleType,
			Control: control,
			Target:  target,
		}, nil
	case "forbidIntegerSentinelAndCidrCoversAllUnlessTrue":
		control, err := requiredString(object, "control", joinPath(path, "control"))
		if err != nil {
			return CrossFieldRule{}, err
		}
		target, err := requiredString(object, "target", joinPath(path, "target"))
		if err != nil {
			return CrossFieldRule{}, err
		}
		if !hasInteger || integer == "" {
			return CrossFieldRule{}, pathError(joinPath(path, "integer"), "integer field is required for this cross-field rule")
		}
		if !hasSentinel || sentinel == nil {
			return CrossFieldRule{}, pathError(joinPath(path, "sentinel"), "sentinel is required for this cross-field rule")
		}
		if err := validateCrossFieldBooleanControl(fields, control, joinPath(path, "control")); err != nil {
			return CrossFieldRule{}, err
		}
		if err := validateCrossFieldIntegerField(fields, integer, joinPath(path, "integer")); err != nil {
			return CrossFieldRule{}, err
		}
		if err := validateCrossFieldCIDRTarget(fields, target, joinPath(path, "target")); err != nil {
			return CrossFieldRule{}, err
		}
		return CrossFieldRule{
			Type:     ruleType,
			Control:  control,
			Target:   target,
			Integer:  integer,
			Sentinel: cloneInt64Pointer(sentinel),
		}, nil
	case "requireFieldWhenEnumEquals":
		if hasControl {
			return CrossFieldRule{}, pathError(joinPath(path, "control"), "control is not supported by this cross-field rule")
		}
		if hasTarget {
			return CrossFieldRule{}, pathError(joinPath(path, "target"), "target is not supported by this cross-field rule")
		}
		if hasInteger {
			return CrossFieldRule{}, pathError(joinPath(path, "integer"), "integer is not supported by this cross-field rule")
		}
		if hasSentinel {
			return CrossFieldRule{}, pathError(joinPath(path, "sentinel"), "sentinel is not supported by this cross-field rule")
		}
		if !hasEnumField || enumField == "" {
			return CrossFieldRule{}, pathError(joinPath(path, "enumField"), "enumField is required for this cross-field rule")
		}
		if !hasEnumValue {
			return CrossFieldRule{}, pathError(joinPath(path, "enumValue"), "enumValue is required for this cross-field rule")
		}
		if !hasField || conditionalField == "" {
			return CrossFieldRule{}, pathError(joinPath(path, "field"), "field is required for this cross-field rule")
		}
		if err := validateCrossFieldEnumConditional(fields, enumField, enumValue, conditionalField, path); err != nil {
			return CrossFieldRule{}, err
		}
		return CrossFieldRule{
			Type:      ruleType,
			EnumField: enumField,
			EnumValue: enumValue,
			HasEnum:   true,
			Field:     conditionalField,
		}, nil
	default:
		return CrossFieldRule{}, pathError(joinPath(path, "type"), "unknown cross-field rule type")
	}
}

// validateCrossFieldEnumConditional checks a requireFieldWhenEnumEquals rule references a required
// enum-string enumField whose enum contains enumValue, and a sibling field that is OPTIONAL and
// carries nullAsAbsent (so explicit null behaves like absent, matching the agent's *string pointer).
func validateCrossFieldEnumConditional(fields map[string]FieldSchema, enumField, enumValue, field, path string) error {
	discriminator, ok := fields[enumField]
	if !ok || discriminator.Type != "string" || !discriminator.Required || len(discriminator.Enum) == 0 {
		return pathError(joinPath(path, "enumField"), "enumField must reference a required enum string sibling field")
	}
	found := false
	for _, value := range discriminator.Enum {
		if value == enumValue {
			found = true
			break
		}
	}
	if !found {
		return pathError(joinPath(path, "enumValue"), "enumValue must be a member of the enumField enum")
	}
	conditional, ok := fields[field]
	if !ok || conditional.Type != "string" {
		return pathError(joinPath(path, "field"), "field must reference a string sibling field")
	}
	if conditional.Required {
		return pathError(joinPath(path, "field"), "field must reference an optional sibling field")
	}
	if !conditional.NullAsAbsent {
		return pathError(joinPath(path, "field"), "field must reference a nullAsAbsent sibling field")
	}
	return nil
}

func optionalCrossFieldFieldList(object jsonObject, key string, path string) ([]string, error) {
	value, ok := object[key]
	if !ok {
		return nil, nil
	}
	array, ok := value.(jsonArray)
	if !ok || len(array) == 0 {
		return nil, pathError(path, "expected non-empty cross-field field array")
	}

	seen := map[string]struct{}{}
	values := make([]string, 0, len(array))
	for index, item := range array {
		stringValue, ok := asJSONString(item)
		if !ok || stringValue.value == "" {
			return nil, pathError(joinPath(path, strconv.Itoa(index)), "expected non-empty cross-field field name")
		}
		if _, exists := seen[stringValue.value]; exists {
			return nil, pathError(joinPath(path, strconv.Itoa(index)), "duplicate cross-field field name")
		}
		seen[stringValue.value] = struct{}{}
		values = append(values, stringValue.value)
	}
	return values, nil
}

func validateCrossFieldExactlyOneOf(fields map[string]FieldSchema, names []string, path string) error {
	if len(names) < 2 {
		return pathError(path, "exactlyOneOf requires at least two fields")
	}
	for index, name := range names {
		field, ok := fields[name]
		if !ok {
			return pathError(joinPath(path, strconv.Itoa(index)), "exactlyOneOf field must reference a sibling field")
		}
		if field.Required {
			return pathError(joinPath(path, strconv.Itoa(index)), "exactlyOneOf field must reference an optional field")
		}
	}
	return nil
}

func validateCrossFieldBooleanControl(fields map[string]FieldSchema, control string, path string) error {
	controlField, ok := fields[control]
	if !ok || controlField.Type != "boolean" {
		return pathError(path, "control field must reference a boolean field")
	}
	return nil
}

func validateCrossFieldArrayTarget(fields map[string]FieldSchema, target string, path string) error {
	targetField, ok := fields[target]
	if !ok || targetField.Type != "array" {
		return pathError(path, "target field must reference an array field")
	}
	return nil
}

func validateCrossFieldIntegerField(fields map[string]FieldSchema, integer string, path string) error {
	integerField, ok := fields[integer]
	if !ok || integerField.Type != "integer" {
		return pathError(path, "integer must reference an integer field")
	}
	return nil
}

func validateCrossFieldCIDRTarget(fields map[string]FieldSchema, target string, path string) error {
	targetField, ok := fields[target]
	if !ok || targetField.Type != "string" || targetField.Format != "cidrLiteral" {
		return pathError(path, "target field must reference a cidrLiteral string field")
	}
	return nil
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
		if err := validateCompiledCrossFieldRule(rule, fields, path); err != nil {
			return compiledManifest{}, err
		}
	}

	return compiledManifest{
		fieldNames:      fieldNames,
		fields:          fields,
		crossFieldRules: append([]CrossFieldRule(nil), manifest.CrossFieldRules...),
	}, nil
}

func validateCompiledCrossFieldRule(rule CrossFieldRule, fields map[string]compiledField, path string) error {
	switch rule.Type {
	case "exactlyOneOf":
		if rule.Control != "" {
			return pathError(joinPath(path, "control"), "control is not supported by this cross-field rule")
		}
		if rule.Target != "" {
			return pathError(joinPath(path, "target"), "target is not supported by this cross-field rule")
		}
		if rule.Integer != "" {
			return pathError(joinPath(path, "integer"), "integer is not supported by this cross-field rule")
		}
		if rule.Sentinel != nil {
			return pathError(joinPath(path, "sentinel"), "sentinel is not supported by this cross-field rule")
		}
		if len(rule.Fields) < 2 {
			return pathError(joinPath(path, "fields"), "exactlyOneOf requires at least two fields")
		}
		seen := map[string]struct{}{}
		for index, name := range rule.Fields {
			if name == "" {
				return pathError(joinPath(joinPath(path, "fields"), strconv.Itoa(index)), "expected non-empty cross-field field name")
			}
			if _, exists := seen[name]; exists {
				return pathError(joinPath(joinPath(path, "fields"), strconv.Itoa(index)), "duplicate cross-field field name")
			}
			seen[name] = struct{}{}
			field, ok := fields[name]
			if !ok {
				return pathError(joinPath(joinPath(path, "fields"), strconv.Itoa(index)), "exactlyOneOf field must reference a sibling field")
			}
			if field.required {
				return pathError(joinPath(joinPath(path, "fields"), strconv.Itoa(index)), "exactlyOneOf field must reference an optional field")
			}
		}
		return nil
	case "requireNonEmptyArrayWhenTrue", "requireEmptyArrayWhenFalse":
		if rule.Integer != "" {
			return pathError(joinPath(path, "integer"), "integer is not supported by this cross-field rule")
		}
		if rule.Sentinel != nil {
			return pathError(joinPath(path, "sentinel"), "sentinel is not supported by this cross-field rule")
		}
		controlField, ok := fields[rule.Control]
		if !ok || controlField.fieldType != "boolean" {
			return pathError(joinPath(path, "control"), "control field must reference a boolean field")
		}
		targetField, ok := fields[rule.Target]
		if !ok || targetField.fieldType != "array" {
			return pathError(joinPath(path, "target"), "target field must reference an array field")
		}
		return nil
	case "forbidIntegerSentinelAndCidrCoversAllUnlessTrue":
		if rule.Integer == "" {
			return pathError(joinPath(path, "integer"), "integer field is required for this cross-field rule")
		}
		if rule.Sentinel == nil {
			return pathError(joinPath(path, "sentinel"), "sentinel is required for this cross-field rule")
		}
		controlField, ok := fields[rule.Control]
		if !ok || controlField.fieldType != "boolean" {
			return pathError(joinPath(path, "control"), "control field must reference a boolean field")
		}
		integerField, ok := fields[rule.Integer]
		if !ok || integerField.fieldType != "integer" {
			return pathError(joinPath(path, "integer"), "integer must reference an integer field")
		}
		targetField, ok := fields[rule.Target]
		if !ok || targetField.fieldType != "string" || targetField.format != "cidrLiteral" {
			return pathError(joinPath(path, "target"), "target field must reference a cidrLiteral string field")
		}
		return nil
	case "requireFieldWhenEnumEquals":
		if rule.Control != "" {
			return pathError(joinPath(path, "control"), "control is not supported by this cross-field rule")
		}
		if rule.Target != "" {
			return pathError(joinPath(path, "target"), "target is not supported by this cross-field rule")
		}
		if rule.Integer != "" {
			return pathError(joinPath(path, "integer"), "integer is not supported by this cross-field rule")
		}
		if rule.Sentinel != nil {
			return pathError(joinPath(path, "sentinel"), "sentinel is not supported by this cross-field rule")
		}
		if rule.EnumField == "" {
			return pathError(joinPath(path, "enumField"), "enumField is required for this cross-field rule")
		}
		if rule.Field == "" {
			return pathError(joinPath(path, "field"), "field is required for this cross-field rule")
		}
		discriminator, ok := fields[rule.EnumField]
		if !ok || discriminator.fieldType != "string" || !discriminator.required || len(discriminator.enumValues) == 0 {
			return pathError(joinPath(path, "enumField"), "enumField must reference a required enum string sibling field")
		}
		if _, ok := discriminator.enumValues[rule.EnumValue]; !ok {
			return pathError(joinPath(path, "enumValue"), "enumValue must be a member of the enumField enum")
		}
		conditional, ok := fields[rule.Field]
		if !ok || conditional.fieldType != "string" {
			return pathError(joinPath(path, "field"), "field must reference a string sibling field")
		}
		if conditional.required {
			return pathError(joinPath(path, "field"), "field must reference an optional sibling field")
		}
		if !conditional.nullAsAbsent {
			return pathError(joinPath(path, "field"), "field must reference a nullAsAbsent sibling field")
		}
		return nil
	default:
		return pathError(joinPath(path, "type"), "unknown cross-field rule type")
	}
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
	if field.Minimum != nil || field.Maximum != nil || field.SentinelValues != nil || field.Items != nil || field.MinItems != nil || field.MaxItems != nil || field.UniqueItems || field.DedupItems || field.UniqueBy != nil || field.SingletonEnumValues != nil || field.RequiredEnumValues != nil || field.UniqueByWhenEnum != nil || field.Fields != nil || field.CrossFieldRules != nil {
		return compiledField{}, pathError(path, "string field contains unsupported constraints")
	}
	if field.MaxLength != nil && (*field.MaxLength < 0 || *field.MaxLength > maxSafeInteger) {
		return compiledField{}, pathError(joinPath(path, "maxLength"), "expected safe integer within bounds")
	}
	if field.MaxBytes != nil && (*field.MaxBytes < 0 || *field.MaxBytes > maxSafeInteger) {
		return compiledField{}, pathError(joinPath(path, "maxBytes"), "expected safe integer within bounds")
	}
	if field.MinLength != nil && (*field.MinLength < 0 || *field.MinLength > maxSafeInteger) {
		return compiledField{}, pathError(joinPath(path, "minLength"), "expected safe integer within bounds")
	}
	if field.Format != "" && !isKnownStringFormat(field.Format) {
		return compiledField{}, pathError(joinPath(path, "format"), "unknown string format")
	}

	enumValues, err := compileStringEnum(field.Enum, joinPath(path, "enum"))
	if err != nil {
		return compiledField{}, err
	}
	notInEnumValues, err := compileStringEnum(field.NotInEnum, joinPath(path, "notInEnum"))
	if err != nil {
		return compiledField{}, err
	}
	minLength := cloneInt64Pointer(field.MinLength)
	if field.NonEmpty && (minLength == nil || *minLength < 1) {
		minLength = newInt64Pointer(1)
	}

	return compiledField{
		fieldType:                "string",
		required:                 field.Required,
		maxLength:                cloneInt64Pointer(field.MaxLength),
		maxBytes:                 cloneInt64Pointer(field.MaxBytes),
		minLength:                minLength,
		enumValues:               enumValues,
		notInEnumValues:          notInEnumValues,
		lowercase:                field.Lowercase,
		noControlChars:           field.NoControlChars,
		noInlineCapsuleMaterial:  field.NoInlineCapsuleMaterial,
		noInlineIdentityMaterial: field.NoInlineIdentityMaterial,
		noInlineMaterial:         field.NoInlineMaterial || field.NoInlineSecrets,
		forbiddenSchemePrefix:    field.ForbiddenSchemePrefix,
		trimmed:                  field.Trimmed,
		format:                   field.Format,
		nullAsAbsent:             field.NullAsAbsent,
	}, nil
}

func compileIntegerFieldSchema(field FieldSchema, path string) (compiledField, error) {
	if field.MaxLength != nil || field.MaxBytes != nil || field.MinLength != nil || field.Enum != nil || field.NotInEnum != nil || field.Lowercase || field.NoControlChars || field.NoInlineCapsuleMaterial || field.NoInlineIdentityMaterial || field.NoInlineMaterial || field.NoInlineSecrets || field.NonEmpty || field.Trimmed || field.ForbiddenSchemePrefix || field.Format != "" || field.Items != nil || field.MinItems != nil || field.MaxItems != nil || field.UniqueItems || field.DedupItems || field.UniqueBy != nil || field.SingletonEnumValues != nil || field.RequiredEnumValues != nil || field.UniqueByWhenEnum != nil || field.Fields != nil || field.CrossFieldRules != nil {
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
	sentinelValues, err := compileIntegerSentinelValues(field.SentinelValues, joinPath(path, "sentinelValues"))
	if err != nil {
		return compiledField{}, err
	}

	return compiledField{
		fieldType:      "integer",
		required:       field.Required,
		minimum:        cloneInt64Pointer(field.Minimum),
		maximum:        cloneInt64Pointer(field.Maximum),
		sentinelValues: sentinelValues,
		nullAsAbsent:   field.NullAsAbsent,
	}, nil
}

func compileBooleanFieldSchema(field FieldSchema, path string) (compiledField, error) {
	if field.MaxLength != nil || field.MaxBytes != nil || field.MinLength != nil || field.Enum != nil || field.NotInEnum != nil || field.Lowercase || field.NoControlChars || field.NoInlineCapsuleMaterial || field.NoInlineIdentityMaterial || field.NoInlineMaterial || field.NoInlineSecrets || field.NonEmpty || field.Trimmed || field.ForbiddenSchemePrefix || field.Format != "" || field.Minimum != nil || field.Maximum != nil || field.SentinelValues != nil || field.Items != nil || field.MinItems != nil || field.MaxItems != nil || field.UniqueItems || field.DedupItems || field.UniqueBy != nil || field.SingletonEnumValues != nil || field.RequiredEnumValues != nil || field.UniqueByWhenEnum != nil || field.Fields != nil || field.CrossFieldRules != nil || field.NullAsAbsent {
		return compiledField{}, pathError(path, "boolean field contains unsupported constraints")
	}

	return compiledField{
		fieldType: "boolean",
		required:  field.Required,
	}, nil
}

func compileArrayFieldSchema(field FieldSchema, path string, depth int, seen map[*FieldSchema]struct{}) (compiledField, error) {
	if field.MaxLength != nil || field.MaxBytes != nil || field.MinLength != nil || field.Enum != nil || field.NotInEnum != nil || field.Lowercase || field.NoControlChars || field.NoInlineCapsuleMaterial || field.NoInlineIdentityMaterial || field.NoInlineMaterial || field.NoInlineSecrets || field.NonEmpty || field.Trimmed || field.ForbiddenSchemePrefix || field.Format != "" || field.Minimum != nil || field.Maximum != nil || field.SentinelValues != nil || field.Fields != nil || field.CrossFieldRules != nil || field.NullAsAbsent {
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
	compiledSingleton, err := compileEnumValuesRule(field.SingletonEnumValues, *field.Items, joinPath(path, "singletonEnumValues"))
	if err != nil {
		return compiledField{}, err
	}
	compiledRequired, err := compileEnumValuesRule(field.RequiredEnumValues, *field.Items, joinPath(path, "requiredEnumValues"))
	if err != nil {
		return compiledField{}, err
	}
	compiledUniqueByWhenEnum, err := compileUniqueByWhenEnumRule(field.UniqueByWhenEnum, *field.Items, joinPath(path, "uniqueByWhenEnum"))
	if err != nil {
		return compiledField{}, err
	}

	seen[field.Items] = struct{}{}
	items, err := compileFieldSchema(*field.Items, joinPath(path, "items"), depth+1, seen)
	delete(seen, field.Items)
	if err != nil {
		return compiledField{}, err
	}

	return compiledField{
		fieldType:           "array",
		required:            field.Required,
		items:               &items,
		minItems:            cloneInt64Pointer(field.MinItems),
		maxItems:            cloneInt64Pointer(field.MaxItems),
		uniqueItems:         field.UniqueItems,
		dedupItems:          field.DedupItems,
		uniqueBy:            cloneStrings(field.UniqueBy),
		singletonEnumValues: compiledSingleton,
		requiredEnumValues:  compiledRequired,
		uniqueByWhenEnum:    compiledUniqueByWhenEnum,
	}, nil
}

func compileEnumValuesRule(rule *EnumValuesRule, items FieldSchema, path string) (*compiledEnumValuesRule, error) {
	if rule == nil {
		return nil, nil
	}
	if rule.Field == "" {
		return nil, pathError(joinPath(path, "field"), "expected non-empty string")
	}
	if len(rule.Values) == 0 {
		return nil, pathError(joinPath(path, "values"), "expected non-empty values array")
	}
	if err := validateEnumDiscriminatorField(items, rule.Field, rule.Values, path); err != nil {
		return nil, err
	}
	values := make(map[string]struct{}, len(rule.Values))
	order := make([]string, 0, len(rule.Values))
	for index, value := range rule.Values {
		if value == "" {
			return nil, pathError(joinPath(joinPath(path, "values"), strconv.Itoa(index)), "expected non-empty enum value")
		}
		if _, exists := values[value]; exists {
			return nil, pathError(joinPath(joinPath(path, "values"), strconv.Itoa(index)), "duplicate enum value")
		}
		values[value] = struct{}{}
		order = append(order, value)
	}
	return &compiledEnumValuesRule{field: rule.Field, values: values, order: order}, nil
}

func compileUniqueByWhenEnumRule(rule *UniqueByWhenEnumRule, items FieldSchema, path string) (*compiledUniqueByWhenEnumRule, error) {
	if rule == nil {
		return nil, nil
	}
	if rule.Field == "" {
		return nil, pathError(joinPath(path, "field"), "expected non-empty string")
	}
	if rule.Value == "" {
		return nil, pathError(joinPath(path, "value"), "expected non-empty string")
	}
	if len(rule.UniqueBy) == 0 {
		return nil, pathError(joinPath(path, "uniqueBy"), "expected non-empty uniqueBy array")
	}
	if err := validateEnumDiscriminatorField(items, rule.Field, []string{rule.Value}, path); err != nil {
		return nil, err
	}
	if err := validateUniqueByFieldsAllowOptional(rule.UniqueBy, items, joinPath(path, "uniqueBy")); err != nil {
		return nil, err
	}
	return &compiledUniqueByWhenEnumRule{field: rule.Field, value: rule.Value, uniqueBy: cloneStrings(rule.UniqueBy)}, nil
}

func compileObjectFieldSchema(field FieldSchema, path string, depth int, seen map[*FieldSchema]struct{}) (compiledField, error) {
	if field.MaxLength != nil || field.MaxBytes != nil || field.MinLength != nil || field.Enum != nil || field.NotInEnum != nil || field.Lowercase || field.NoControlChars || field.NoInlineCapsuleMaterial || field.NoInlineIdentityMaterial || field.NoInlineMaterial || field.NoInlineSecrets || field.NonEmpty || field.Trimmed || field.ForbiddenSchemePrefix || field.Format != "" || field.Minimum != nil || field.Maximum != nil || field.SentinelValues != nil || field.Items != nil || field.MinItems != nil || field.MaxItems != nil || field.UniqueItems || field.DedupItems || field.UniqueBy != nil || field.SingletonEnumValues != nil || field.RequiredEnumValues != nil || field.UniqueByWhenEnum != nil || field.NullAsAbsent {
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
		if err := validateCompiledCrossFieldRule(rule, fields, rulePath); err != nil {
			return compiledField{}, err
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

// fieldNullCountsAsAbsent reports whether a present-but-null OPTIONAL field carrying nullAsAbsent
// must be treated exactly like a missing key (skipped, not type-checked, not counted by
// exactlyOneOf). Mirrors the agent's omitempty pointer fields: encoding/json decodes a present
// JSON null to nil ⇒ absent. JSON null decodes to a Go nil jsonValue here. Only string/integer
// compiled schemas ever carry nullAsAbsent (parse + compile reject it elsewhere).
func fieldNullCountsAsAbsent(field compiledField, raw jsonValue) bool {
	return raw == nil && !field.required && field.nullAsAbsent
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
	if field.noInlineMaterial && containsInlineServiceMaterial(raw.value) {
		return nil, pathError(path, "inline material is not allowed")
	}
	if field.noInlineCapsuleMaterial && containsInlineCapsuleMaterial(raw.value) {
		return nil, pathError(path, "inline capsule material is not allowed")
	}
	if field.noInlineIdentityMaterial && containsInlineIdentityMaterial(raw.value) {
		return nil, pathError(path, "inline identity material is not allowed")
	}
	if field.forbiddenSchemePrefix && hasInlineReferenceScheme(raw.value) {
		return nil, pathError(path, "forbidden scheme prefix is not allowed")
	}
	if field.noControlChars && containsControlCharacter(raw.value) {
		return nil, pathError(path, "control characters are not allowed")
	}
	if field.trimmed && raw.value != strings.TrimSpace(raw.value) {
		return nil, pathError(path, "string must be trimmed")
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
	if field.maxBytes != nil && int64(len(normalized)) > *field.maxBytes {
		return nil, pathError(path, "string exceeds maxBytes")
	}
	if field.minLength != nil && int64(len(normalized)) < *field.minLength {
		return nil, pathError(path, "string is shorter than minLength")
	}
	if field.enumValues != nil {
		if _, ok := field.enumValues[normalized]; !ok {
			return nil, pathError(path, "string is not in the allowed enum")
		}
	}
	if field.notInEnumValues != nil {
		if _, blocked := field.notInEnumValues[normalized]; blocked {
			return nil, pathError(path, "string is in the blocked enum")
		}
	}
	return normalized, nil
}

func validateIntegerField(value jsonValue, field compiledField, path string) (capabilityValue, error) {
	number, ok := value.(json.Number)
	if !ok {
		return nil, pathError(path, "expected safe integer")
	}
	parsed, err := parseJSONSafeInteger(number)
	if err != nil {
		return nil, pathError(path, "expected safe integer")
	}
	_, isSentinel := field.sentinelValues[parsed]
	if !isSentinel {
		if field.minimum != nil && parsed < *field.minimum {
			return nil, pathError(path, "integer is below minimum")
		}
		if field.maximum != nil && parsed > *field.maximum {
			return nil, pathError(path, "integer is above maximum")
		}
	}
	return float64(parsed), nil
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
	seenDedupItems := map[string]int{}
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
		if field.dedupItems {
			key := uniqueValueKey(normalized)
			if _, ok := seenDedupItems[key]; ok {
				continue
			}
			seenDedupItems[key] = index
		}
		if len(field.uniqueBy) > 0 {
			keys, err := uniqueByValueKeys(normalized, field.uniqueBy, itemPath)
			if err != nil {
				return nil, err
			}
			for _, key := range keys {
				if previous, ok := seenUniqueBy[key]; ok {
					return nil, pathError(itemPath, fmt.Sprintf("duplicate array item key also appears at %s", joinPath(path, strconv.Itoa(previous))))
				}
				seenUniqueBy[key] = index
			}
		}
		output = append(output, normalized)
	}
	if err := applyEnumDiscriminatedArrayRules(output, field, path); err != nil {
		return nil, err
	}
	return output, nil
}

// applyEnumDiscriminatedArrayRules evaluates the whole-list enum-discriminated invariants over the
// fully-normalized array (singleton-subset, filtered uniqueBy, required coverage), mirroring storage
// normalizeLayout. Per-item validation has already run; these only read the discriminator string.
func applyEnumDiscriminatedArrayRules(output capabilityArray, field compiledField, path string) error {
	if singleton := field.singletonEnumValues; singleton != nil {
		seen := map[string]int{}
		for index, item := range output {
			discriminator, ok := enumDiscriminatorValue(item, singleton.field)
			if !ok {
				continue
			}
			if _, listed := singleton.values[discriminator]; !listed {
				continue
			}
			if previous, ok := seen[discriminator]; ok {
				return pathError(joinPath(joinPath(path, strconv.Itoa(index)), singleton.field), fmt.Sprintf("%s value %s also appears at %s", singleton.field, discriminator, joinPath(path, strconv.Itoa(previous))))
			}
			seen[discriminator] = index
		}
	}

	if rule := field.uniqueByWhenEnum; rule != nil {
		seen := map[string]int{}
		for index, item := range output {
			discriminator, ok := enumDiscriminatorValue(item, rule.field)
			if !ok || discriminator != rule.value {
				continue
			}
			itemPath := joinPath(path, strconv.Itoa(index))
			keys, err := uniqueByValueKeys(item, rule.uniqueBy, itemPath)
			if err != nil {
				return pathError(itemPath, "uniqueByWhenEnum requires the keyed fields to be present on matched items")
			}
			for _, key := range keys {
				if previous, ok := seen[key]; ok {
					return pathError(itemPath, fmt.Sprintf("duplicate %s=%s key also appears at %s", rule.field, rule.value, joinPath(path, strconv.Itoa(previous))))
				}
				seen[key] = index
			}
		}
	}

	if required := field.requiredEnumValues; required != nil {
		present := map[string]struct{}{}
		for _, item := range output {
			if discriminator, ok := enumDiscriminatorValue(item, required.field); ok {
				present[discriminator] = struct{}{}
			}
		}
		for _, value := range required.order {
			if _, ok := present[value]; !ok {
				return pathError(path, fmt.Sprintf("missing required %s value %s", required.field, value))
			}
		}
	}

	return nil
}

func enumDiscriminatorValue(item capabilityValue, field string) (string, bool) {
	object, ok := item.(capabilityObject)
	if !ok {
		return "", false
	}
	value, ok := object[field].(string)
	if !ok {
		return "", false
	}
	return value, true
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
		if fieldNullCountsAsAbsent(childField, raw) {
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
		if rule.Type == "exactlyOneOf" {
			present := 0
			for _, name := range rule.Fields {
				if _, ok := value[name]; ok {
					present++
				}
			}
			if present != 1 {
				return pathError(path, fmt.Sprintf("exactly one of %s must be set", strings.Join(rule.Fields, ", ")))
			}
			continue
		}

		if rule.Type == "requireFieldWhenEnumEquals" {
			discriminator, ok := value[rule.EnumField].(string)
			if !ok {
				return pathError(joinPath(path, rule.EnumField), "cross-field rule references invalid fields")
			}
			fieldValue, present := value[rule.Field]
			fieldPath := joinPath(path, rule.Field)
			if discriminator == rule.EnumValue {
				// Required AND non-empty when the discriminator matches (mirrors the agent's
				// AppID == nil || *AppID == "" rejection for app-state).
				stringValue, isString := fieldValue.(string)
				if !present || !isString || stringValue == "" {
					return pathError(fieldPath, fmt.Sprintf("%s is required when %s is %s", rule.Field, rule.EnumField, rule.EnumValue))
				}
			} else if present {
				// Forbidden when the discriminator does not match (mirrors the agent's
				// AppID != nil rejection for non-app-state).
				return pathError(fieldPath, fmt.Sprintf("%s is only allowed when %s is %s", rule.Field, rule.EnumField, rule.EnumValue))
			}
			continue
		}

		targetPath := joinPath(path, rule.Target)

		switch rule.Type {
		case "requireNonEmptyArrayWhenTrue":
			control, target, ok := crossFieldBoolAndArray(value, rule)
			if !ok {
				return pathError(targetPath, "cross-field rule references invalid fields")
			}
			if control && len(target) == 0 {
				return pathError(targetPath, fmt.Sprintf("%s must be non-empty when %s is true", rule.Target, rule.Control))
			}
		case "requireEmptyArrayWhenFalse":
			control, target, ok := crossFieldBoolAndArray(value, rule)
			if !ok {
				return pathError(targetPath, "cross-field rule references invalid fields")
			}
			if !control && len(target) != 0 {
				return pathError(targetPath, fmt.Sprintf("%s must be empty when %s is false", rule.Target, rule.Control))
			}
		case "forbidIntegerSentinelAndCidrCoversAllUnlessTrue":
			integer, ok := value[rule.Integer].(float64)
			if !ok {
				return pathError(targetPath, "cross-field rule references invalid fields")
			}
			target, ok := value[rule.Target].(string)
			if !ok {
				return pathError(targetPath, "cross-field rule references invalid fields")
			}
			controlValue, hasControl := value[rule.Control]
			control := false
			if hasControl {
				var ok bool
				control, ok = controlValue.(bool)
				if !ok {
					return pathError(targetPath, "cross-field rule references invalid fields")
				}
			}
			if rule.Sentinel == nil {
				return pathError(targetPath, "cross-field rule references invalid fields")
			}
			if integer == float64(*rule.Sentinel) && cidrLiteralCoversAll(target) && !control {
				return pathError(targetPath, fmt.Sprintf("%s %d with %s covering all sources requires %s true", rule.Integer, *rule.Sentinel, rule.Target, rule.Control))
			}
		default:
			return pathError(targetPath, "unknown cross-field rule type")
		}
	}
	return nil
}

func crossFieldBoolAndArray(value map[string]capabilityValue, rule CrossFieldRule) (bool, capabilityArray, bool) {
	controlValue, hasControl := value[rule.Control]
	targetValue, hasTarget := value[rule.Target]
	if !hasControl || !hasTarget {
		return false, nil, false
	}
	control, ok := controlValue.(bool)
	if !ok {
		return false, nil, false
	}
	target, ok := targetValue.(capabilityArray)
	if !ok {
		return false, nil, false
	}
	return control, target, true
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

func optionalSafeIntegerArray(object jsonObject, key string, path string, minimum int64, maximum int64) ([]int64, error) {
	value, ok := object[key]
	if !ok {
		return nil, nil
	}
	array, ok := value.(jsonArray)
	if !ok || len(array) == 0 {
		return nil, pathError(path, "expected non-empty safe integer array")
	}

	seen := map[int64]struct{}{}
	values := make([]int64, 0, len(array))
	for index, item := range array {
		integer, err := readSafeInteger(item, joinPath(path, strconv.Itoa(index)), minimum, maximum)
		if err != nil {
			return nil, err
		}
		if _, exists := seen[integer]; exists {
			return nil, pathError(joinPath(path, strconv.Itoa(index)), "duplicate safe integer value")
		}
		seen[integer] = struct{}{}
		values = append(values, integer)
	}
	return values, nil
}

func readSafeInteger(value jsonValue, path string, minimum int64, maximum int64) (int64, error) {
	number, ok := value.(json.Number)
	if !ok {
		return 0, pathError(path, "expected safe integer within bounds")
	}
	parsed, err := parseJSONSafeInteger(number)
	if err != nil || parsed < minimum || parsed > maximum {
		return 0, pathError(path, "expected safe integer within bounds")
	}
	return parsed, nil
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

func compileIntegerSentinelValues(values []int64, path string) (map[int64]struct{}, error) {
	if values == nil {
		return nil, nil
	}
	if len(values) == 0 {
		return nil, pathError(path, "expected non-empty safe integer array")
	}

	seen := make(map[int64]struct{}, len(values))
	for index, value := range values {
		if value < -maxSafeInteger || value > maxSafeInteger {
			return nil, pathError(joinPath(path, strconv.Itoa(index)), "expected safe integer within bounds")
		}
		if _, exists := seen[value]; exists {
			return nil, pathError(joinPath(path, strconv.Itoa(index)), "duplicate safe integer value")
		}
		seen[value] = struct{}{}
	}
	return seen, nil
}

func parseJSONSafeInteger(number json.Number) (int64, error) {
	raw := number.String()
	if !isJSONIntegerLiteral(raw) {
		return 0, fmt.Errorf("not an integer literal")
	}
	parsed, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, err
	}
	if parsed < -maxSafeInteger || parsed > maxSafeInteger {
		return 0, fmt.Errorf("integer outside safe range")
	}
	return parsed, nil
}

func isJSONIntegerLiteral(value string) bool {
	if value == "" {
		return false
	}
	start := 0
	if value[0] == '-' {
		start = 1
	}
	if start >= len(value) {
		return false
	}
	for index := start; index < len(value); index++ {
		if !isASCIIDigit(value[index]) {
			return false
		}
	}
	return true
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
	case "cidrLiteral":
		return canonicalizeCIDRLiteral(value)
	case "networkInterfaceName":
		if isNetworkInterfaceName(value) {
			return value, true
		}
		return "", false
	case "hostnameOrIp":
		if ip, ok := canonicalizeIPLiteral(value); ok {
			return ip, true
		}
		if isAgentHostname(value) {
			return strings.ToLower(value), true
		}
		return "", false
	case "posixUsername", "posixAccountName", "groupName":
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
	case "capsuleId":
		if isCapsuleID(value) {
			return value, true
		}
		return "", false
	case "capsuleVersion":
		if isCapsuleVersion(value) {
			return value, true
		}
		return "", false
	case "sriIntegrity":
		if isValidSRI(value) {
			return value, true
		}
		return "", false
	case "bundleRefString":
		if isBundleRefString(value) {
			return value, true
		}
		return "", false
	case "bundleVersionString":
		if isBundleVersionString(value) {
			return value, true
		}
		return "", false
	case "didPlcOrWeb":
		if isSupportedDID(value) {
			return value, true
		}
		return "", false
	case "atprotoHandle":
		if isDomainHandle(value) {
			return value, true
		}
		return "", false
	case "keyReference":
		if isKeyReference(value) {
			return value, true
		}
		return "", false
	case "backupRef":
		if isBackupRef(value) {
			return value, true
		}
		return "", false
	case "cron5OrMacro":
		if isCron5OrMacro(value) {
			return value, true
		}
		return "", false
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
		format == "posixAccountName" ||
		format == "groupName" ||
		format == "systemdUnitName" ||
		format == "absolutePath" ||
		format == "rfc3339Instant" ||
		format == "capsuleId" ||
		format == "capsuleVersion" ||
		format == "sriIntegrity" ||
		format == "bundleRefString" ||
		format == "bundleVersionString" ||
		format == "didPlcOrWeb" ||
		format == "atprotoHandle" ||
		format == "keyReference" ||
		format == "backupRef" ||
		format == "cron5OrMacro" ||
		format == "cidrLiteral" ||
		format == "networkInterfaceName"
}

func isCapsuleID(value string) bool {
	if len(value) > 255 ||
		value != strings.TrimSpace(value) ||
		containsControlCharacter(value) ||
		containsInlineCapsuleMaterial(value) ||
		hasInlineReferenceScheme(value) {
		return false
	}
	return isReverseDNSCapsuleID(value) || isOpaqueCapsuleID(value)
}

func isCapsuleVersion(value string) bool {
	if len(value) > 128 ||
		value != strings.TrimSpace(value) ||
		containsControlCharacter(value) ||
		containsInlineCapsuleMaterial(value) ||
		hasInlineReferenceScheme(value) {
		return false
	}
	return isCapsuleVersionPattern(value)
}

func isBundleRefString(value string) bool {
	if value == "" || len(value) > 256 || !isASCIIAlphaNumeric(value[0]) {
		return false
	}
	for index := 1; index < len(value); index++ {
		if !isBundleRefChar(value[index]) {
			return false
		}
	}
	return true
}

func isBundleVersionString(value string) bool {
	if value == "" || len(value) > 128 || !isASCIIAlphaNumeric(value[0]) {
		return false
	}
	for index := 1; index < len(value); index++ {
		if !isBundleVersionChar(value[index]) {
			return false
		}
	}
	return true
}

const (
	didPlcPrefix          = "did:plc:"
	didWebPrefix          = "did:web:"
	maxAtprotoHandleBytes = 253
	maxDIDBytes           = 2048
	maxKeyReferenceBytes  = 2048
)

var inlineReferenceSchemes = map[string]struct{}{
	"data":    {},
	"inline":  {},
	"literal": {},
}

func isSupportedDID(value string) bool {
	if len(value) > maxDIDBytes || value != strings.TrimSpace(value) {
		return false
	}
	return isDIDPlc(value) || isDIDWeb(value)
}

func isDIDPlc(value string) bool {
	if !strings.HasPrefix(value, didPlcPrefix) {
		return false
	}

	identifier := value[len(didPlcPrefix):]
	if len(identifier) != 24 {
		return false
	}

	for index := 0; index < len(identifier); index++ {
		char := identifier[index]
		if !isASCIILowercase(char) && (char < '2' || char > '7') {
			return false
		}
	}
	return true
}

func isDIDWeb(value string) bool {
	if !strings.HasPrefix(value, didWebPrefix) {
		return false
	}

	identifier := value[len(didWebPrefix):]
	if identifier == "" ||
		strings.Contains(identifier, "/") ||
		strings.Contains(identifier, "?") ||
		strings.Contains(identifier, "#") ||
		containsControlCharacter(identifier) {
		return false
	}

	segments := strings.Split(identifier, ":")
	if len(segments) == 0 || !isDomainHandle(segments[0]) {
		return false
	}

	for index := 1; index < len(segments); index++ {
		segment := segments[index]
		if segment == "" ||
			segment == "." ||
			segment == ".." ||
			!isDIDWebPathSegment(segment) {
			return false
		}
	}
	return true
}

func isDIDWebPathSegment(value string) bool {
	if value == "" {
		return false
	}

	for index := 0; index < len(value); index++ {
		char := value[index]
		if isASCIIAlphaNumeric(char) || char == '.' || char == '_' || char == '~' || char == '-' {
			continue
		}
		if char == '%' && index+2 < len(value) && isASCIIHex(value[index+1]) && isASCIIHex(value[index+2]) {
			index += 2
			continue
		}
		return false
	}
	return true
}

func isDomainHandle(value string) bool {
	if len(value) < 3 ||
		len(value) > maxAtprotoHandleBytes ||
		value != strings.TrimSpace(value) ||
		value != strings.ToLower(value) ||
		strings.Contains(value, "://") ||
		strings.Contains(value, "/") ||
		strings.Contains(value, ":") ||
		strings.HasSuffix(value, ".") {
		return false
	}

	labels := strings.Split(value, ".")
	if len(labels) < 2 {
		return false
	}

	for _, label := range labels {
		if !isDomainHandleLabel(label) {
			return false
		}
	}

	topLevelLabel := labels[len(labels)-1]
	return len(topLevelLabel) >= 2 && !allDigits(topLevelLabel)
}

func isDomainHandleLabel(value string) bool {
	if len(value) == 0 || len(value) > 63 {
		return false
	}
	for index := 0; index < len(value); index++ {
		char := value[index]
		if index == 0 || index == len(value)-1 {
			if !isASCIILowerAlphaNumeric(char) {
				return false
			}
		} else if !isASCIILowerAlphaNumeric(char) && char != '-' {
			return false
		}
	}
	return true
}

func isKeyReference(value string) bool {
	return value != "" &&
		!containsInlineIdentityMaterial(value) &&
		len(value) <= maxKeyReferenceBytes &&
		isReferenceSyntax(value)
}

func isReferenceSyntax(value string) bool {
	if value != strings.TrimSpace(value) || containsControlCharacter(value) {
		return false
	}
	for _, r := range value {
		switch r {
		case '<', '>', '{', '}', '`', '"', '\'':
			return false
		}
		if r == ' ' || r == '\t' || r == '\n' || r == '\r' || r == '\v' || r == '\f' {
			return false
		}
	}

	separator := strings.Index(value, "://")
	if separator == -1 {
		return isOpaqueKeyReference(value)
	}
	if separator <= 0 || separator == len(value)-3 {
		return false
	}

	scheme := strings.ToLower(value[:separator])
	if !isReferenceScheme(scheme) {
		return false
	}
	if _, forbidden := inlineReferenceSchemes[scheme]; forbidden {
		return false
	}
	return value[separator+3:] != ""
}

func isOpaqueKeyReference(value string) bool {
	if value == "" || len(value) > 256 || !isASCIIAlphaNumeric(value[0]) {
		return false
	}
	for index := 1; index < len(value); index++ {
		char := value[index]
		if !isASCIIAlphaNumeric(char) && char != '.' && char != '_' && char != ':' && char != '@' && char != '-' {
			return false
		}
	}
	return true
}

func isReferenceScheme(value string) bool {
	if value == "" || !isASCIILowercase(value[0]) {
		return false
	}
	for index := 1; index < len(value); index++ {
		char := value[index]
		if !isASCIILowerAlphaNumeric(char) && char != '+' && char != '.' && char != '-' {
			return false
		}
	}
	return true
}

const maxBackupRefBytes = 2048

// isBackupRef mirrors agent/capabilities/backup.validateRef + validReferenceSyntax exactly: it
// rejects empty values, inline secret material (the backup SECRET scanner), values longer than
// 2048 bytes, and anything that is not an opaque reference (backup's OWN {2,159} opaque pattern) or
// a non-inline scheme:// URI.
func isBackupRef(value string) bool {
	return value != "" &&
		!containsInlineBackupMaterial(value) &&
		len(value) <= maxBackupRefBytes &&
		isBackupReferenceSyntax(value)
}

func isBackupReferenceSyntax(value string) bool {
	if value != strings.TrimSpace(value) || strings.ContainsAny(value, " \t\r\n<>{}`\"'") {
		return false
	}
	if hasInlineReferenceScheme(value) {
		return false
	}

	separator := strings.Index(value, "://")
	if separator == -1 {
		return isBackupOpaqueRef(value)
	}
	if separator <= 0 || separator == len(value)-3 {
		return false
	}

	scheme := strings.ToLower(value[:separator])
	body := value[separator+3:]
	if _, forbidden := inlineReferenceSchemes[scheme]; forbidden {
		return false
	}
	return isReferenceScheme(scheme) && body != ""
}

// isBackupOpaqueRef mirrors backup.opaqueRefPattern `^[A-Za-z0-9][A-Za-z0-9._:@-]{2,159}$`: a
// leading alphanumeric byte followed by 2..159 of `[A-Za-z0-9._:@-]` (total length 3..160).
func isBackupOpaqueRef(value string) bool {
	if len(value) < 3 || len(value) > 160 || !isASCIIAlphaNumeric(value[0]) {
		return false
	}
	for index := 1; index < len(value); index++ {
		char := value[index]
		if !isASCIIAlphaNumeric(char) && char != '.' && char != '_' && char != ':' && char != '@' && char != '-' {
			return false
		}
	}
	return true
}

// containsInlineBackupMaterial mirrors backup.containsInlineSecretMaterial exactly: control chars,
// the `-----BEGIN` substring (case-insensitive, unbounded), the privateKey/secretAssignment/seed
// regex families, and the long hex / long base64 runs. This is the SECRET variant; the capsule
// scanner already encodes the identical regex set, so it is reused verbatim plus the control-char
// guard that backup's scanner adds.
func containsInlineBackupMaterial(value string) bool {
	return containsControlCharacter(value) || containsInlineCapsuleMaterial(value)
}

var backupCronMacros = map[string]struct{}{
	"@hourly":  {},
	"@daily":   {},
	"@weekly":  {},
	"@monthly": {},
}

type backupCronBounds struct {
	min int
	max int
}

var backupCronFieldBounds = []backupCronBounds{
	{min: 0, max: 59},
	{min: 0, max: 23},
	{min: 1, max: 31},
	{min: 1, max: 12},
	{min: 0, max: 7},
}

// isCron5OrMacro mirrors backup.validCronSchedule exactly: a supported `@hourly|@daily|@weekly|
// @monthly` macro, or 5 whitespace-separated fields with comma-lists, `A-B` ranges and `/step`
// steps validated against the per-position bounds. Inline secret material, surrounding whitespace
// and empty values are rejected.
func isCron5OrMacro(value string) bool {
	if value == "" || value != strings.TrimSpace(value) || containsInlineBackupMaterial(value) {
		return false
	}
	if _, ok := backupCronMacros[value]; ok {
		return true
	}

	fields := strings.Fields(value)
	if len(fields) != len(backupCronFieldBounds) {
		return false
	}
	for index, field := range fields {
		if !validBackupCronField(field, backupCronFieldBounds[index]) {
			return false
		}
	}
	return true
}

func validBackupCronField(field string, bounds backupCronBounds) bool {
	if field == "" {
		return false
	}
	for _, part := range strings.Split(field, ",") {
		if !validBackupCronPart(part, bounds) {
			return false
		}
	}
	return true
}

func validBackupCronPart(part string, bounds backupCronBounds) bool {
	if part == "" {
		return false
	}

	base := part
	if strings.Contains(part, "/") {
		pieces := strings.Split(part, "/")
		if len(pieces) != 2 || pieces[0] == "" || pieces[1] == "" {
			return false
		}
		step, err := strconv.Atoi(pieces[1])
		if err != nil || step < 1 || step > bounds.max {
			return false
		}
		base = pieces[0]
	}

	if base == "*" {
		return true
	}
	if strings.Contains(base, "-") {
		pieces := strings.Split(base, "-")
		if len(pieces) != 2 {
			return false
		}
		start, ok := parseBackupCronNumber(pieces[0], bounds)
		if !ok {
			return false
		}
		end, ok := parseBackupCronNumber(pieces[1], bounds)
		return ok && start <= end
	}
	_, ok := parseBackupCronNumber(base, bounds)
	return ok
}

func parseBackupCronNumber(value string, bounds backupCronBounds) (int, bool) {
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return 0, false
	}
	return parsed, parsed >= bounds.min && parsed <= bounds.max
}

func allDigits(value string) bool {
	if value == "" {
		return false
	}
	for _, r := range value {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func isReverseDNSCapsuleID(value string) bool {
	if value == "" {
		return false
	}

	labelStart := 0
	labelCount := 0
	for index := 0; index <= len(value); index++ {
		if index < len(value) && value[index] != '.' {
			continue
		}
		if !isReverseDNSCapsuleLabel(value, labelStart, index) {
			return false
		}
		labelCount++
		labelStart = index + 1
	}
	return labelCount >= 2
}

func isReverseDNSCapsuleLabel(value string, start int, end int) bool {
	length := end - start
	if length <= 0 || length > 63 {
		return false
	}

	for index := start; index < end; index++ {
		char := value[index]
		if index == start || index == end-1 {
			if !isASCIILowerAlphaNumeric(char) {
				return false
			}
		} else if !isASCIILowerAlphaNumeric(char) && char != '-' {
			return false
		}
	}
	return true
}

func isOpaqueCapsuleID(value string) bool {
	if len(value) < 3 || len(value) > 160 || !isASCIIAlphaNumeric(value[0]) {
		return false
	}
	for index := 1; index < len(value); index++ {
		if !isOpaqueCapsuleIDChar(value[index]) {
			return false
		}
	}
	return true
}

func isCapsuleVersionPattern(value string) bool {
	if value == "" || len(value) > 128 || !isASCIIAlphaNumeric(value[0]) {
		return false
	}
	for index := 1; index < len(value); index++ {
		if !isCapsuleVersionChar(value[index]) {
			return false
		}
	}
	return true
}

func isValidSRI(value string) bool {
	separator := strings.IndexByte(value, '-')
	if separator == -1 || strings.IndexByte(value[separator+1:], '-') != -1 {
		return false
	}

	expectedLength := 0
	switch value[:separator] {
	case "sha256":
		expectedLength = 32
	case "sha384":
		expectedLength = 48
	case "sha512":
		expectedLength = 64
	default:
		return false
	}

	digest := value[separator+1:]
	if !isSRIDigestToken(digest) {
		return false
	}

	var decoded []byte
	var err error
	if strings.Contains(digest, "=") {
		decoded, err = base64.StdEncoding.DecodeString(digest)
	} else {
		decoded, err = base64.RawStdEncoding.DecodeString(digest)
	}
	return err == nil && len(decoded) == expectedLength
}

func isSRIDigestToken(value string) bool {
	if value == "" {
		return false
	}

	padding := 0
	for index := len(value) - 1; index >= 0 && value[index] == '='; index-- {
		padding++
	}
	if padding > 2 {
		return false
	}

	for index := 0; index < len(value)-padding; index++ {
		if !isStandardBase64Char(value[index]) {
			return false
		}
	}
	for index := len(value) - padding; index < len(value); index++ {
		if value[index] != '=' {
			return false
		}
	}
	return true
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
	return !containsInlineKeyMaterial(value)
}

func containsInlineKeyMaterial(value string) bool {
	lower := asciiLowercase(value)
	return containsDataURLPattern(lower) ||
		containsPEMBlockPattern(lower) ||
		containsLongBase64Run(value)
}

func containsDataURLPattern(value string) bool {
	for start := strings.Index(value, "data:"); start != -1; start = nextStringIndex(value, "data:", start+1) {
		if start == 0 || !isASCIIRegexWord(value[start-1]) {
			return true
		}
	}
	return false
}

func containsPEMBlockPattern(value string) bool {
	for start := strings.Index(value, "-----begin"); start != -1; start = nextStringIndex(value, "-----begin", start+1) {
		afterIndex := start + len("-----begin")
		if afterIndex >= len(value) || !isASCIIRegexWord(value[afterIndex]) {
			return true
		}
	}
	return false
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
	servicePrivateMaterialTokens    = [][]string{
		{"private", "key"},
		{"openssh", "private", "key"},
		{"age", "secret", "key"},
		{"xprv"},
		{"seed", "phrase"},
		{"mnemonic"},
		{"recovery", "phrase"},
	}
	serviceSecretAssignmentTokens = [][]string{
		{"private", "key"},
		{"api", "key"},
		{"access", "token"},
		{"refresh", "token"},
		{"password"},
		{"secret"},
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

func containsInlineCapsuleMaterial(value string) bool {
	lower := asciiLowercase(value)
	return strings.Contains(lower, "-----begin") ||
		containsCapsulePrivateKeyPattern(lower) ||
		containsCapsuleSecretAssignment(lower) ||
		containsSeedWordsPattern(lower) ||
		containsLongHexRun(value) ||
		containsLongBase64Run(value)
}

func containsInlineIdentityMaterial(value string) bool {
	lower := asciiLowercase(value)
	return containsControlCharacter(value) ||
		containsPEMBlockPattern(lower) ||
		containsCapsulePrivateKeyPattern(lower) ||
		containsIdentitySecretAssignment(lower, value) ||
		containsSeedWordsPattern(lower) ||
		containsLongHexRun(value) ||
		containsLongBase64Run(value)
}

func containsCapsulePrivateKeyPattern(value string) bool {
	return containsBoundedToken(value, []string{"private", "key"}) ||
		containsOpenSSHPrivateKeyPattern(value) ||
		containsBoundedLiteral(value, "age-secret-key") ||
		containsBoundedLiteral(value, "xprv") ||
		containsBoundedToken(value, []string{"seed", "phrase"}) ||
		containsBoundedLiteral(value, "mnemonic") ||
		containsBoundedToken(value, []string{"recovery", "phrase"})
}

func containsCapsuleSecretAssignment(value string) bool {
	return containsSecretAssignmentToken(value, []string{"private", "key"}) ||
		containsSecretAssignmentToken(value, []string{"api", "key"}) ||
		containsSecretAssignmentToken(value, []string{"access", "token"}) ||
		containsSecretAssignmentToken(value, []string{"refresh", "token"}) ||
		containsSecretAssignmentToken(value, []string{"password"}) ||
		containsSecretAssignmentToken(value, []string{"secret"})
}

func containsIdentitySecretAssignment(lower string, original string) bool {
	return containsIdentitySecretAssignmentToken(lower, original, []string{"private", "key"}) ||
		containsIdentitySecretAssignmentToken(lower, original, []string{"api", "key"}) ||
		containsIdentitySecretAssignmentToken(lower, original, []string{"access", "token"}) ||
		containsIdentitySecretAssignmentToken(lower, original, []string{"refresh", "token"}) ||
		containsIdentitySecretAssignmentToken(lower, original, []string{"password"}) ||
		containsIdentitySecretAssignmentToken(lower, original, []string{"secret"})
}

func containsOpenSSHPrivateKeyPattern(value string) bool {
	for start := strings.Index(value, "openssh"); start != -1; start = nextStringIndex(value, "openssh", start+1) {
		if start != 0 && isASCIIRegexWord(value[start-1]) {
			continue
		}

		offset := start + len("openssh")
		firstSpace, ok := readASCIIRegexWhitespaceRun(value, offset)
		if !ok || !strings.HasPrefix(value[firstSpace:], "private") {
			continue
		}

		offset = firstSpace + len("private")
		secondSpace, ok := readASCIIRegexWhitespaceRun(value, offset)
		if !ok || !strings.HasPrefix(value[secondSpace:], "key") {
			continue
		}

		offset = secondSpace + len("key")
		if offset >= len(value) || !isASCIIRegexWord(value[offset]) {
			return true
		}
	}
	return false
}

func readASCIIRegexWhitespaceRun(value string, start int) (int, bool) {
	if start >= len(value) || !isASCIIRegexWhitespace(value[start]) {
		return 0, false
	}
	offset := start
	for offset < len(value) && isASCIIRegexWhitespace(value[offset]) {
		offset++
	}
	return offset, true
}

func containsBoundedLiteral(value string, literal string) bool {
	for start := strings.Index(value, literal); start != -1; start = nextStringIndex(value, literal, start+1) {
		afterIndex := start + len(literal)
		beforeOK := start == 0 || !isASCIIRegexWord(value[start-1])
		afterOK := afterIndex >= len(value) || !isASCIIRegexWord(value[afterIndex])
		if beforeOK && afterOK {
			return true
		}
	}
	return false
}

func containsSeedWordsPattern(value string) bool {
	for start := 0; start < len(value); {
		if !isASCIIAlpha(value[start]) {
			start++
			continue
		}
		if start != 0 && isASCIIRegexWord(value[start-1]) {
			start = skipASCIILetters(value, start)
			continue
		}

		offset := start
		words := 0
		for {
			wordEnd := skipASCIILetters(value, offset)
			wordLength := wordEnd - offset
			if wordLength < 3 || wordLength > 12 {
				break
			}

			words++
			if words >= 12 && (wordEnd >= len(value) || !isASCIIRegexWord(value[wordEnd])) {
				return true
			}

			nextWord, ok := readASCIIRegexWhitespaceRun(value, wordEnd)
			if !ok || nextWord >= len(value) || !isASCIIAlpha(value[nextWord]) {
				break
			}
			offset = nextWord
		}

		start = skipASCIILetters(value, start)
	}
	return false
}

func skipASCIILetters(value string, start int) int {
	offset := start
	for offset < len(value) && isASCIIAlpha(value[offset]) {
		offset++
	}
	return offset
}

func containsIdentitySecretAssignmentToken(lower string, original string, token []string) bool {
	if len(token) == 0 {
		return false
	}
	first := token[0]
	for start := strings.Index(lower, first); start != -1; start = nextStringIndex(lower, first, start+1) {
		if start != 0 && isASCIIRegexWord(lower[start-1]) {
			continue
		}

		afterIndex, ok := matchSeparatedToken(lower, token, start)
		if !ok {
			continue
		}
		for afterIndex < len(lower) && isASCIIRegexWhitespace(lower[afterIndex]) {
			afterIndex++
		}
		if afterIndex < len(lower) && (lower[afterIndex] == ':' || lower[afterIndex] == '=') {
			if lower[afterIndex] == ':' && strings.HasPrefix(original[afterIndex+1:], "//") {
				continue
			}
			return true
		}
	}
	return false
}

func containsBoundedToken(value string, token []string) bool {
	if len(token) == 0 {
		return false
	}
	first := token[0]
	for start := strings.Index(value, first); start != -1; start = nextStringIndex(value, first, start+1) {
		afterIndex, ok := matchSeparatedToken(value, token, start)
		if !ok {
			continue
		}
		beforeOK := start == 0 || !isASCIIRegexWord(value[start-1])
		afterOK := afterIndex >= len(value) || !isASCIIRegexWord(value[afterIndex])
		if beforeOK && afterOK {
			return true
		}
	}
	return false
}

func containsSecretAssignmentToken(value string, token []string) bool {
	if len(token) == 0 {
		return false
	}
	first := token[0]
	for start := strings.Index(value, first); start != -1; start = nextStringIndex(value, first, start+1) {
		if start != 0 && isASCIIRegexWord(value[start-1]) {
			continue
		}

		afterIndex, ok := matchSeparatedToken(value, token, start)
		if !ok {
			continue
		}
		for afterIndex < len(value) && isASCIIRegexWhitespace(value[afterIndex]) {
			afterIndex++
		}
		if afterIndex < len(value) && (value[afterIndex] == ':' || value[afterIndex] == '=') {
			return true
		}
	}
	return false
}

func matchSeparatedToken(value string, token []string, start int) (int, bool) {
	offset := start
	for index, segment := range token {
		if !strings.HasPrefix(value[offset:], segment) {
			return 0, false
		}
		offset += len(segment)
		if index+1 < len(token) && offset < len(value) && isServiceTokenSeparator(value[offset]) {
			offset++
		}
	}
	return offset, true
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

func canonicalizeCIDRLiteral(value string) (string, bool) {
	if value == "" || value != strings.TrimSpace(value) {
		return "", false
	}
	prefix, err := netip.ParsePrefix(value)
	if err != nil {
		return "", false
	}
	return prefix.Masked().String(), true
}

func cidrLiteralCoversAll(value string) bool {
	if value == "" || value != strings.TrimSpace(value) {
		return false
	}
	prefix, err := netip.ParsePrefix(value)
	if err != nil {
		return false
	}
	masked := prefix.Masked()
	return masked.Bits() == 0 && masked.Addr().IsUnspecified()
}

func isNetworkInterfaceName(value string) bool {
	if value == "" || len(value) > 15 || value != strings.TrimSpace(value) {
		return false
	}
	for index := 0; index < len(value); index++ {
		char := value[index]
		if index == 0 {
			if !isASCIIAlphaNumeric(char) {
				return false
			}
			continue
		}
		if !isASCIIAlphaNumeric(char) && char != '_' && char != '.' && char != ':' && char != '-' {
			return false
		}
	}
	return true
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

func uniqueByValueKeys(value capabilityValue, uniqueBy []string, path string) ([]string, error) {
	object, ok := value.(capabilityObject)
	if !ok {
		return nil, pathError(path, "uniqueBy requires object array items with all key fields present")
	}

	parts := make([]string, 0, len(uniqueBy))
	for _, fieldName := range uniqueBy {
		item, ok := object[fieldName]
		if !ok {
			return nil, pathError(path, "uniqueBy requires object array items with all key fields present")
		}
		parts = append(parts, fieldName+":"+uniqueValueKey(item))
	}
	return parts, nil
}

func isASCIIAlphaNumeric(char byte) bool {
	return (char >= '0' && char <= '9') ||
		(char >= 'A' && char <= 'Z') ||
		(char >= 'a' && char <= 'z')
}

func isASCIIAlpha(char byte) bool {
	return (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z')
}

func isASCIILowercase(char byte) bool {
	return char >= 'a' && char <= 'z'
}

func isASCIILowerAlphaNumeric(char byte) bool {
	return isASCIIDigit(char) || isASCIILowercase(char)
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

func isServiceTokenSeparator(char byte) bool {
	return char == '-' || char == '_' || isASCIIRegexWhitespace(char)
}

func isASCIIRegexWhitespace(char byte) bool {
	return char == '\t' || char == '\n' || char == '\f' || char == '\r' || char == ' '
}

func isSystemdUnitNameChar(char byte) bool {
	return isASCIIAlphaNumeric(char) || char == ':' || char == '.' || char == '_' || char == '@' || char == '-'
}

func isOpaqueCapsuleIDChar(char byte) bool {
	return isASCIIAlphaNumeric(char) || char == '.' || char == '_' || char == ':' || char == '-'
}

func isCapsuleVersionChar(char byte) bool {
	return isASCIIAlphaNumeric(char) || char == '.' || char == '+' || char == '_' || char == '-'
}

func isBundleRefChar(char byte) bool {
	return isASCIIAlphaNumeric(char) || char == '.' || char == '_' || char == ':' || char == '@' || char == '/' || char == '-'
}

func isBundleVersionChar(char byte) bool {
	return isASCIIAlphaNumeric(char) || char == '.' || char == '+' || char == '_' || char == '-'
}

func isStandardBase64Char(char byte) bool {
	return isASCIIAlphaNumeric(char) || char == '+' || char == '/'
}

func cloneInt64Pointer(value *int64) *int64 {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}

func newInt64Pointer(value int64) *int64 {
	return &value
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
