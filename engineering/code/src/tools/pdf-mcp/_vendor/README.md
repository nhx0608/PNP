# Vendored dependencies

Everything under this directory is a third-party package unpacked from its published wheel and
committed as-is. Nothing here is modified. `main.py` puts this directory at the front of `sys.path`,
so these copies win over anything the machine happens to have installed — `server_info` reports
`dependencies[].vendored`, which is `true` exactly when the copy in use came from here.

## Why vendored at all

The delivery is unpacked from `solution.zip` onto a Windows machine with no internet. `pip install`
at deploy time is not available, so a dependency that is not in the package does not exist.

## Why only pure-Python wheels

A wheel tagged `cp313-…` is compiled for one CPython minor version and fails to import on any other.
The judge's interpreter is not ours to choose, so a compiled wheel would turn a working delivery into
a broken one on a machine running 3.11 instead of 3.13. Only `py3-none-any` wheels are vendored here.
That rules out `lxml`, `Pillow`, `cryptography` and everything that depends on them — which is also
why the usual PDF table extractors (`pdfplumber` → `pdfminer.six` → `cryptography`) are absent, and
why `tables.py` implements the detection itself.

## pypdf 6.13.3

| | |
| --- | --- |
| Wheel | `pypdf-6.13.3-py3-none-any.whl` |
| Wheel SHA-256 | `c6e3f86afb625791510b02ad5480e94b63970bb957df75d44657c282ecc52224` |
| Wheel size | 347,288 bytes |
| Unpacked | 60 files, 1,491,250 bytes (1.42 MiB) |
| `Root-Is-Purelib` | `true` (`Tag: py3-none-any`) |
| `Requires-Python` | `>=3.9` — the floor this whole package declares |
| Runtime dependencies | none |
| Licence | BSD-3-Clause, kept at `pypdf-6.13.3.dist-info/licenses/LICENSE` |

`pypdf` has no required runtime dependency at all: it uses `cryptography` or `pycryptodome` *only*
for AES-encrypted documents, and neither is vendored, so such a file is reported as
`DEPENDENCY_UNAVAILABLE` with the reason rather than as an unreadable or empty document. Its image
*decoding* path wants Pillow; this server never calls it, counting images from the page's resource
dictionary instead (`pdf_read._image_xobject_count`).

## Reproducing this directory

```powershell
pip download pypdf==6.13.3 --no-deps --only-binary=:all: -d .
python -c "import zipfile; zipfile.ZipFile('pypdf-6.13.3-py3-none-any.whl').extractall('_vendor')"
```

`tests/test_pdf_mcp.py::PythonFloorTest` re-checks the two properties this table claims — the
`py3-none-any` tag and `Requires-Python: >=3.9` — from the files actually present here, and parses
every one of them with `ast.parse(feature_version=(3, 9))`.

`__pycache__/` directories appear here the first time the server runs and are ignored by
`.gitignore`; they are a per-interpreter build artefact, not part of the vendored package.
