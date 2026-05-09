## Read

Use Read for local files. Always pass an absolute `file_path`.

For normal text/code files, use this shape:

```json
{
  "file_path": "/absolute/path/to/file.ts",
  "offset": 0,
  "limit": 200,
  "pages": "1"
}
```

Always include `pages` with a valid 1-indexed value. For normal text/code files, use `"1"`.

Never use this shape:

```json
{
  "file_path": "/absolute/path/to/file.ts",
  "offset": 0,
  "limit": 200,
  "pages": ""
}
```

For PDFs, use the specific page or range you need:

```json
{
  "file_path": "/absolute/path/to/file.pdf",
  "pages": "1-5"
}
```
