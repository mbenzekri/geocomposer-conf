import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';

const schemaPath = 'schemas/config.schema.json';
const configPath = 'config.json';

const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
const configText = readFileSync(configPath, 'utf8');
const config = JSON.parse(configText);
const locations = collectJsonLocations(configText);

const ajv = new Ajv2020({
  allErrors: true,
  strict: false,
  verbose: true,
});

const requiredPropertiesBySourceType = {
  csv: new Set(['path']),
  geojson: new Set(['path']),
  gml: new Set(['path']),
  shp: new Set(['shpPath', 'dbfPath']),
  gpkg: new Set(['path', 'datasets']),
  postgis: new Set(['connection', 'datasets']),
  mssql: new Set(['connection', 'datasets']),
  oracle: new Set(['connection', 'datasets']),
};

const validate = ajv.compile(schema);

if (validate(config)) {
  console.log(`${configPath} valid against ${schemaPath}`);
  process.exit(0);
}

const noisyKeywords = new Set(['anyOf', 'oneOf', 'const', 'pattern', 'type']);
const actionable = validate.errors.filter(isHelpfulError);
const errors = actionable.length > 0 ? actionable : validate.errors;
const seen = new Set();

for (const error of errors) {
  const line = formatError(error);
  if (seen.has(line)) continue;
  seen.add(line);
  console.error(line);
}

process.exit(1);

function formatError(error) {
  const path = error.instancePath || '/';
  const targetPath = locationPathForError(error);
  const location = locations.get(targetPath) ?? locations.get(path) ?? { line: 1, column: 1 };
  const prefix = `${configPath}:${location.line}:${location.column}: error:`;

  if (error.keyword === 'required') {
    return `${prefix} ${path}: missing required property '${error.params.missingProperty}'`;
  }

  if (error.keyword === 'unevaluatedProperties') {
    return `${prefix} ${path}: unexpected property '${error.params.unevaluatedProperty}'`;
  }

  if (error.keyword === 'additionalProperties') {
    return `${prefix} ${path}: unexpected property '${error.params.additionalProperty}'`;
  }

  return `${prefix} ${path}: ${error.message}`;
}

function isHelpfulError(error) {
  if (noisyKeywords.has(error.keyword)) return false;

  if (error.keyword === 'required') {
    const missing = error.params.missingProperty;
    if (missing === '$ref') return false;

    const source = sourceForPath(error.instancePath);
    if (source?.type) {
      const required = requiredPropertiesBySourceType[source.type];
      return required ? required.has(missing) : true;
    }
  }

  return true;
}

function sourceForPath(instancePath) {
  const match = instancePath.match(/^\/sources\/([^/]+)$/);
  if (!match) return null;
  return config.sources?.[match[1]] ?? null;
}

function locationPathForError(error) {
  if (error.keyword === 'unevaluatedProperties') {
    return appendPointer(error.instancePath, error.params.unevaluatedProperty);
  }

  if (error.keyword === 'additionalProperties') {
    return appendPointer(error.instancePath, error.params.additionalProperty);
  }

  return error.instancePath || '/';
}

function appendPointer(instancePath, segment) {
  const encoded = String(segment).replace(/~/g, '~0').replace(/\//g, '~1');
  return `${instancePath || ''}/${encoded}`;
}

function collectJsonLocations(text) {
  const lineStarts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') lineStarts.push(index + 1);
  }

  let index = 0;
  const map = new Map();

  parseValue('/');
  return map;

  function parseValue(pointer) {
    skipWhitespace();
    const start = index;
    map.set(pointer, positionForOffset(start));

    const char = text[index];
    if (char === '{') return parseObject(pointer);
    if (char === '[') return parseArray(pointer);
    if (char === '"') return parseString();
    return parseLiteral();
  }

  function parseObject(pointer) {
    index += 1;
    skipWhitespace();
    if (text[index] === '}') {
      index += 1;
      return;
    }

    while (index < text.length) {
      skipWhitespace();
      const keyStart = index;
      const key = parseString();
      const childPointer = appendPointer(pointer === '/' ? '' : pointer, key);
      map.set(childPointer, positionForOffset(keyStart));

      skipWhitespace();
      expect(':');
      parseValue(childPointer);

      skipWhitespace();
      if (text[index] === '}') {
        index += 1;
        return;
      }
      expect(',');
    }
  }

  function parseArray(pointer) {
    index += 1;
    skipWhitespace();
    if (text[index] === ']') {
      index += 1;
      return;
    }

    let itemIndex = 0;
    while (index < text.length) {
      parseValue(appendPointer(pointer === '/' ? '' : pointer, itemIndex));
      itemIndex += 1;
      skipWhitespace();
      if (text[index] === ']') {
        index += 1;
        return;
      }
      expect(',');
    }
  }

  function parseString() {
    expect('"');
    let value = '';

    while (index < text.length) {
      const char = text[index];
      if (char === '"') {
        index += 1;
        return value;
      }
      if (char === '\\') {
        index += 1;
        value += text[index] ?? '';
        index += 1;
        continue;
      }
      value += char;
      index += 1;
    }

    return value;
  }

  function parseLiteral() {
    while (index < text.length && !/[\s,\]}]/.test(text[index])) {
      index += 1;
    }
  }

  function skipWhitespace() {
    while (index < text.length && /\s/.test(text[index])) index += 1;
  }

  function expect(char) {
    if (text[index] !== char) {
      throw new Error(`Expected '${char}' while locating JSON errors`);
    }
    index += 1;
  }

  function positionForOffset(offset) {
    let low = 0;
    let high = lineStarts.length - 1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (lineStarts[mid] <= offset) low = mid + 1;
      else high = mid - 1;
    }

    const lineIndex = high;
    return {
      line: lineIndex + 1,
      column: offset - lineStarts[lineIndex] + 1,
    };
  }
}
