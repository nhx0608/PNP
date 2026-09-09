"""Standalone tests for the PDF MCP server / PDF MCP 服务器的独立测试。

`pytest` is not available on the judge's machine and the delivery is offline, so this uses
`unittest` from the standard library and nothing else. Run it with:

    python src/tools/pdf-mcp/run-tests.py

Every PDF the tests read is written by the test itself (`pdf_fixtures.py`), so each assertion is
about a document whose exact contents are stated in the test rather than about a binary nobody can
inspect.
"""

from __future__ import annotations

import ast
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PACKAGE = os.path.dirname(HERE)
VENDOR = os.path.join(PACKAGE, "_vendor")
for entry in (VENDOR, PACKAGE, HERE):
    if entry not in sys.path:
        sys.path.insert(0, entry)

import pdf_fixtures as fixtures  # noqa: E402
import server as pdf_server  # noqa: E402
import tables as tables_module  # noqa: E402
from paths import require_absolute_path  # noqa: E402

MINIMUM_PYTHON = (3, 9)
#: 3.10+ only. Its absence never fails the suite — it downgrades one check to a skip with a reason.
STDLIB_MODULE_NAMES = getattr(sys, "stdlib_module_names", None)

TABLE_ROWS = [
    ["Item", "Qty", "Unit", "Total"],
    ["Bolt M8", "120", "0.35", "42.00"],
    ["Washer", "1450", "0.02", "29.00"],
    ["Nut M8", "980", "0.11", "107.80"],
]


def call(tool_name, arguments):
    """Invoke a tool exactly as `tools/call` would, and return the MCP result envelope."""
    server = pdf_server.create_server()
    return server._call_tool({"name": tool_name, "arguments": arguments})  # noqa: SLF001


def data_of(result):
    assert result.get("isError") is not True, text_of(result)
    return result["structuredContent"]


def text_of(result):
    return "\n".join(block.get("text", "") for block in result.get("content", []))


def expect_error(result, fragment):
    assert result.get("isError") is True, "expected an error result, got: %s" % text_of(result)
    body = text_of(result)
    assert fragment in body, "expected the error to mention %r, got: %s" % (fragment, body)
    return body


class WorkspaceTest(unittest.TestCase):
    """Base class giving every test a scratch directory whose name contains Chinese characters.

    Evaluation tasks hand the model paths like `D:\\评测\\库存\\西安分公司.pdf`. A server that only
    ever sees ASCII paths in its tests has not been shown to work on the paths it will actually get.
    """

    def setUp(self):
        self._temp = tempfile.TemporaryDirectory(prefix="pnp-pdf-")
        self.workspace = os.path.join(self._temp.name, "评测-库存")
        os.makedirs(self.workspace)
        self.addCleanup(self._temp.cleanup)

    def fixture(self, name, pages, metadata=None):
        path = os.path.join(self.workspace, name)
        fixtures.write(path, fixtures.build_pdf(pages, metadata=metadata))
        return path

    def named(self, name, filename):
        path = os.path.join(self.workspace, filename)
        return fixtures.write(path, fixtures.named(name))

    def report(self):
        """A four-page document: text, a table, a scanned page, a blank page.

        The same bytes the Node adapter test asserts against — `pdf_fixtures.named` is the single
        definition, reached from TypeScript through `python pdf_fixtures.py report <path>`.
        """
        return self.named("report", "西安分公司报告.pdf")


# -- the Python floor ------------------------------------------------------------------------------

class PythonFloorTest(unittest.TestCase):
    def test_every_shipped_python_file_parses_at_the_declared_floor(self):
        """The claim "Python 3.9+" is verified, not asserted.

        `ast.parse(feature_version=...)` makes the parser refuse syntax newer than that release, so
        this fails on the first `match` statement or parenthesised context manager that creeps into
        either this package or the vendored dependency.
        """
        checked = 0
        for root, _dirs, files in os.walk(PACKAGE):
            for name in files:
                if not name.endswith(".py"):
                    continue
                path = os.path.join(root, name)
                with open(path, "rb") as handle:
                    source = handle.read().decode("utf-8")
                checked += 1
                try:
                    ast.parse(source, filename=path, feature_version=MINIMUM_PYTHON)
                except SyntaxError as error:
                    self.fail("%s does not parse as Python %d.%d: %s"
                              % (path, MINIMUM_PYTHON[0], MINIMUM_PYTHON[1], error))
        self.assertGreater(checked, 55, "the vendored package should have been walked too")

    def test_the_vendored_wheel_is_pure_python_and_declares_the_same_floor(self):
        """A `cp313` wheel would break a judge running 3.11; `py3-none-any` cannot."""
        with open(os.path.join(VENDOR, "pypdf-6.13.3.dist-info", "WHEEL"), encoding="utf-8") as handle:
            wheel = handle.read()
        self.assertIn("Tag: py3-none-any", wheel)
        with open(os.path.join(VENDOR, "pypdf-6.13.3.dist-info", "METADATA"), encoding="utf-8") as handle:
            metadata = handle.read()
        self.assertIn("Requires-Python: >=3.9", metadata)
        self.assertTrue(os.path.exists(os.path.join(VENDOR, "pypdf-6.13.3.dist-info", "licenses", "LICENSE")))

    def test_the_vendored_copy_is_the_one_that_loads(self):
        import pypdf
        self.assertTrue(os.path.abspath(pypdf.__file__).startswith(VENDOR + os.sep),
                        "pypdf must come from _vendor, not from whatever is installed: %s" % pypdf.__file__)

    def test_no_dependency_outside_the_standard_library_and_the_vendored_tree(self):
        """Every third-party import in this package must resolve inside `_vendor`."""
        if STDLIB_MODULE_NAMES is None:
            self.skipTest("sys.stdlib_module_names needs Python 3.10+; this interpreter is %s"
                          % ".".join(str(part) for part in sys.version_info[:3]))
        allowed = {"pypdf"}
        own = {name[:-3] for name in os.listdir(PACKAGE) if name.endswith(".py")}
        for name in sorted(os.listdir(PACKAGE)):
            if not name.endswith(".py"):
                continue
            with open(os.path.join(PACKAGE, name), "rb") as handle:
                tree = ast.parse(handle.read().decode("utf-8"), filename=name)
            for node in ast.walk(tree):
                roots = []
                if isinstance(node, ast.Import):
                    roots = [alias.name.split(".")[0] for alias in node.names]
                elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                    roots = [node.module.split(".")[0]]
                for root in roots:
                    if root in own or root in allowed:
                        continue
                    self.assertIn(root, STDLIB_MODULE_NAMES,
                                  "%s imports %r, which is neither stdlib nor vendored" % (name, root))


# -- absolute-path discipline ----------------------------------------------------------------------

class PathDisciplineTest(WorkspaceTest):
    def test_a_relative_path_is_refused_rather_than_resolved(self):
        expect_error(call("pdf_extract", {"path": "report.pdf"}), "PATH_NOT_ABSOLUTE")

    def test_a_tilde_or_environment_variable_is_refused_rather_than_expanded(self):
        expect_error(call("pdf_info", {"path": "~/report.pdf"}), "PATH_NOT_ABSOLUTE")
        expect_error(call("pdf_info", {"path": "%USERPROFILE%\\report.pdf"}), "PATH_NOT_ABSOLUTE")
        expect_error(call("pdf_info", {"path": "$HOME/report.pdf"}), "PATH_NOT_ABSOLUTE")

    def test_a_windows_path_is_accepted_as_absolute_on_any_platform(self):
        self.assertEqual(require_absolute_path("path", "D:\\评测\\库存.pdf").replace("/", "\\"),
                         "D:\\评测\\库存.pdf")

    def test_a_missing_file_and_a_directory_are_told_apart(self):
        expect_error(call("pdf_info", {"path": os.path.join(self.workspace, "缺失.pdf")}), "PATH_NOT_FOUND")
        expect_error(call("pdf_info", {"path": self.workspace}), "NOT_A_FILE")

    def test_a_file_that_is_not_a_pdf_is_refused_by_its_header_not_its_extension(self):
        decoy = os.path.join(self.workspace, "其实是文本.pdf")
        with open(decoy, "wb") as handle:
            handle.write(b"PK\x03\x04 this is really a zip\n")
        expect_error(call("pdf_extract", {"path": decoy}), "UNSUPPORTED_FORMAT")

    def test_a_missing_or_mistyped_argument_names_the_field(self):
        expect_error(call("pdf_extract", {}), "path")
        expect_error(call("pdf_extract", {"path": 42}), "path")
        expect_error(call("pdf_extract", {"path": "D:\\a.pdf", "firstPage": "1"}), "firstPage")

    def test_a_chinese_directory_name_round_trips(self):
        path = self.report()
        self.assertIn("评测-库存", path)
        self.assertEqual(data_of(call("pdf_info", {"path": path}))["pageCount"], 4)


# -- pdf_info --------------------------------------------------------------------------------------

class PdfInfoTest(WorkspaceTest):
    def test_reports_pages_sizes_metadata_and_the_text_layer(self):
        info = data_of(call("pdf_info", {"path": self.report()}))
        self.assertEqual(info["pageCount"], 4)
        self.assertEqual(info["pdfVersion"], "1.7")
        self.assertFalse(info["encrypted"])
        self.assertTrue(info["hasTextLayer"])
        self.assertTrue(info["textLayerCertain"])
        self.assertTrue(info["textLayerScannedEveryPage"])
        self.assertEqual(info["metadata"]["title"], "库存报告 Inventory")
        self.assertEqual(info["metadata"]["author"], "PNP")
        self.assertEqual(info["metadata"]["producer"], "pnp-pdf-mcp-tests")
        first = info["pageSizes"][0]
        self.assertEqual(first["page"], 1)
        self.assertAlmostEqual(first["widthPt"], 595.28, places=1)
        self.assertAlmostEqual(first["widthMm"], 210.0, places=0)
        self.assertEqual(first["orientation"], "portrait")
        self.assertEqual(info["pageKinds"], {"text": 2, "image-only": 1, "no-content": 1})
        self.assertGreater(info["bytes"], 0)

    def test_reports_rotation_and_a_landscape_page(self):
        path = self.fixture("横向.pdf", [
            {"operations": [fixtures.text_line(40, 400, "Landscape")], "size": (842.0, 595.0), "rotate": 90},
        ])
        info = data_of(call("pdf_info", {"path": path}))
        self.assertEqual(info["pageSizes"][0]["rotation"], 90)
        self.assertEqual(info["pageSizes"][0]["orientation"], "landscape")

    def test_a_document_with_no_text_layer_at_all_is_reported_as_such_with_certainty(self):
        path = self.named("scan", "扫描件.pdf")
        info = data_of(call("pdf_info", {"path": path}))
        self.assertFalse(info["hasTextLayer"])
        self.assertTrue(info["textLayerCertain"])
        self.assertEqual(info["pageKinds"], {"image-only": 2})
        self.assertTrue(any("扫描件" in note or "scan" in note for note in info["notes"]),
                        "a scan must be named as a likely scan: %s" % info["notes"])

    def test_a_long_document_says_how_much_of_it_was_actually_read(self):
        pages = [{"blank": True} for _ in range(60)]
        pages[59] = {"operations": [fixtures.text_line(72, 700, "Only the last page has text")]}
        path = self.fixture("长文档.pdf", pages)
        info = data_of(call("pdf_info", {"path": path}))
        self.assertEqual(info["pageCount"], 60)
        self.assertTrue(info["hasTextLayer"], "the sample must reach the last page")
        self.assertTrue(info["textLayerCertain"])
        self.assertLessEqual(info["textLayerPagesScanned"], 60)


# -- pdf_extract -----------------------------------------------------------------------------------

class PdfExtractTest(WorkspaceTest):
    def test_extracts_text_per_page_with_the_page_count_and_metadata(self):
        result = data_of(call("pdf_extract", {"path": self.report()}))
        self.assertEqual(result["pageCount"], 4)
        self.assertEqual(result["firstPage"], 1)
        self.assertEqual(result["lastPage"], 4)
        self.assertEqual(len(result["pages"]), 4)
        self.assertIn("Quarterly Inventory Report", result["pages"][0]["text"])
        self.assertIn("Xian branch office", result["pages"][0]["text"])
        self.assertTrue(result["pages"][0]["hasText"])
        self.assertEqual(result["metadata"]["title"], "库存报告 Inventory")

    def test_a_scanned_page_is_reported_as_image_only_not_as_a_blank_page(self):
        result = data_of(call("pdf_extract", {"path": self.report()}))
        scanned = result["pages"][2]
        self.assertEqual(scanned["kind"], "image-only")
        self.assertFalse(scanned["hasText"])
        self.assertGreaterEqual(scanned["imageCount"], 1)
        self.assertEqual(scanned["text"], "")
        self.assertIn(3, result["imageOnlyPages"])
        self.assertIn(3, result["pagesWithoutText"])
        joined = " ".join(result["notes"])
        self.assertIn("OCR", joined)
        self.assertTrue("扫描" in joined or "scanned" in joined)

    def test_a_genuinely_blank_page_is_told_apart_from_a_scanned_one(self):
        result = data_of(call("pdf_extract", {"path": self.report()}))
        blank = result["pages"][3]
        self.assertEqual(blank["kind"], "no-content")
        self.assertEqual(blank["imageCount"], 0)
        self.assertIn(4, result["pagesWithoutText"])
        self.assertNotIn(4, result["imageOnlyPages"])

    def test_a_page_range_selects_pages_and_a_range_past_the_end_is_clamped(self):
        path = self.report()
        ranged = data_of(call("pdf_extract", {"path": path, "firstPage": 2, "lastPage": 3}))
        self.assertEqual([page["page"] for page in ranged["pages"]], [2, 3])
        clamped = data_of(call("pdf_extract", {"path": path, "firstPage": 3, "lastPage": 99}))
        self.assertEqual(clamped["lastPage"], 4)
        expect_error(call("pdf_extract", {"path": path, "firstPage": 9}), "INDEX_OUT_OF_RANGE")
        expect_error(call("pdf_extract", {"path": path, "firstPage": 3, "lastPage": 2}), "INVALID_ARGUMENT")
        expect_error(call("pdf_extract", {"path": path, "firstPage": 0}), "INVALID_ARGUMENT")

    def test_truncation_is_reported_rather_than_silent(self):
        long_page = self.fixture("长正文.pdf", [{"operations": [
            fixtures.text_line(60, 780 - index * 14, "Line %02d: this sentence exists only to exceed the cap." % index)
            for index in range(40)
        ]}])
        result = data_of(call("pdf_extract", {"path": long_page, "maxCharsPerPage": 100}))
        self.assertGreater(result["pages"][0]["characters"], 100)
        self.assertTrue(result["pages"][0]["truncated"])
        self.assertEqual(len(result["pages"][0]["text"]), 100)
        self.assertIn(1, result["truncatedPages"])
        self.assertTrue(any("truncat" in note for note in result["notes"]))

    def test_include_text_false_returns_the_classification_without_the_body(self):
        result = data_of(call("pdf_extract", {"path": self.report(), "includeText": False}))
        self.assertEqual(result["characters"], 0)
        for page in result["pages"]:
            self.assertNotIn("text", page)
        self.assertEqual([page["kind"] for page in result["pages"]],
                         ["text", "text", "image-only", "no-content"])


# -- pdf_extract_tables ----------------------------------------------------------------------------

class PdfExtractTablesTest(WorkspaceTest):
    def test_a_whitespace_aligned_table_is_recovered_cell_by_cell_with_high_confidence(self):
        path = self.fixture("表格.pdf", [{"operations": fixtures.text_grid(TABLE_ROWS)}])
        result = data_of(call("pdf_extract_tables", {"path": path}))
        self.assertEqual(result["tableCount"], 1)
        table = result["tables"][0]
        self.assertEqual(table["page"], 1)
        self.assertEqual(table["columns"], 4)
        self.assertEqual(table["rows"], TABLE_ROWS)
        self.assertEqual(table["header"], ["Item", "Qty", "Unit", "Total"])
        self.assertEqual(table["confidence"], "high")
        self.assertEqual(table["completeRowRatio"], 1.0)
        self.assertEqual(table["signals"], [])

    def test_the_caveat_states_what_the_method_cannot_do(self):
        path = self.fixture("表格2.pdf", [{"operations": fixtures.text_grid(TABLE_ROWS)}])
        result = data_of(call("pdf_extract_tables", {"path": path}))
        self.assertIn("layout", result["method"])
        caveat = result["caveat"].lower()
        for fragment in ("ruling lines", "scanned", "merged cells", "confidence"):
            self.assertIn(fragment, caveat)

    def test_prose_is_not_turned_into_a_table(self):
        path = self.named("prose", "正文.pdf")
        result = data_of(call("pdf_extract_tables", {"path": path}))
        self.assertEqual(result["tableCount"], 0)
        self.assertTrue(any("No whitespace-aligned table" in note for note in result["notes"]))

    def test_a_scanned_page_is_reported_as_having_no_text_layer_not_as_having_no_tables(self):
        result = data_of(call("pdf_extract_tables", {"path": self.report()}))
        pages = {entry["page"]: entry["kind"] for entry in result["pagesWithoutTextLayer"]}
        self.assertEqual(pages.get(3), "image-only")
        self.assertEqual(pages.get(4), "no-content")
        self.assertTrue(any("OCR" in note for note in result["notes"]))

    def test_a_two_row_table_is_downgraded_for_being_too_small_a_sample(self):
        path = self.fixture("小表.pdf", [{"operations": fixtures.text_grid(TABLE_ROWS[:2])}])
        result = data_of(call("pdf_extract_tables", {"path": path}))
        table = result["tables"][0]
        self.assertEqual(table["confidence"], "medium")
        self.assertTrue(any("too small a sample" in signal for signal in table["signals"]))

    def test_min_confidence_filters_and_says_how_many_it_dropped(self):
        path = self.fixture("小表2.pdf", [{"operations": fixtures.text_grid(TABLE_ROWS[:2])}])
        result = data_of(call("pdf_extract_tables", {"path": path, "minConfidence": "high"}))
        self.assertEqual(result["tableCount"], 0)
        self.assertEqual(result["droppedBelowMinConfidence"], 1)
        expect_error(call("pdf_extract_tables", {"path": path, "minConfidence": "certain"}), "minConfidence")

    def test_a_centred_header_over_left_aligned_data_is_merged_back_into_one_column(self):
        """The real failure mode measured on a Word-exported PDF, isolated as a unit.

        The centred header and the left-aligned numbers occupy different strips of the character
        grid, so the blank-everywhere test finds a separator between them that is not a column
        boundary. Two columns that are never both occupied in the same row are one column.
        """
        def line(*cells):
            out = ""
            for column, text in cells:
                out = out.ljust(column) + text
            return out

        # The header sits to the right of the data it labels, so the blank-everywhere test finds a
        # separator inside each real column. Without the merge this reads as five columns of which
        # no row fills more than three.
        layout = "\n".join([
            line((0, "月份"), (20, "Mate 系列"), (40, "Pura 系列")),
            line((0, "一月"), (12, "1280"), (32, "940")),
            line((0, "二月"), (12, "1190"), (32, "1010")),
            line((0, "三月"), (12, "1360"), (32, "1080")),
        ])
        detected = tables_module.detect_tables(layout, 1)
        self.assertEqual(len(detected), 1)
        self.assertEqual(detected[0]["columns"], 3)
        self.assertEqual(detected[0]["mergedColumnBoundaries"], 2)
        self.assertEqual(detected[0]["rows"], [
            ["月份", "Mate 系列", "Pura 系列"],
            ["一月", "1280", "940"],
            ["二月", "1190", "1010"],
            ["三月", "1360", "1080"],
        ])
        self.assertTrue(any("merged" in signal for signal in detected[0]["signals"]),
                        "a merged boundary must be disclosed, not silently applied")


# -- server_info and the MCP envelope --------------------------------------------------------------

class ServerInfoTest(unittest.TestCase):
    def test_reports_the_version_the_interpreter_and_the_vendored_dependency(self):
        info = data_of(call("server_info", {}))
        self.assertEqual(info["name"], "pdf")
        self.assertEqual(info["implementation"], "python")
        self.assertRegex(info["version"], r"^\d+\.\d+\.\d+$")
        self.assertEqual(info["pythonFloor"], "3.9")
        self.assertEqual(info["pythonVersion"].split(".")[0], "3")
        dependency = info["dependencies"][0]
        self.assertEqual(dependency["name"], "pypdf")
        self.assertTrue(dependency["vendored"])
        self.assertTrue(dependency["pure_python"])
        self.assertEqual(sorted(tool["name"] for tool in info["tools"]),
                         ["pdf_extract", "pdf_extract_tables", "pdf_info", "server_info"])
        self.assertTrue(all(tool["sideEffect"] == "read" for tool in info["tools"]),
                        "this server is declared sideEffect:read in settings.json")


class McpEnvelopeTest(unittest.TestCase):
    def setUp(self):
        self.server = pdf_server.create_server()

    def test_every_tool_publishes_a_bilingual_description_and_an_object_schema(self):
        listed = self.server._list_tools()["tools"]  # noqa: SLF001
        self.assertEqual(sorted(tool["name"] for tool in listed),
                         ["pdf_extract", "pdf_extract_tables", "pdf_info", "server_info"])
        for tool in listed:
            self.assertTrue(any("\u4e00" <= character <= "\u9fff" for character in tool["description"]),
                            "%s has no Chinese description" % tool["name"])
            self.assertRegex(tool["description"], r"[A-Za-z]{4,}")
            self.assertEqual(tool["inputSchema"]["type"], "object")
            self.assertTrue(tool["annotations"]["title"])
            self.assertTrue(tool["annotations"]["readOnlyHint"], "every tool here is read-only")
            self.assertEqual(tool["_meta"]["sideEffect"], "read")

    def test_initialize_echoes_a_supported_protocol_version_and_falls_back_otherwise(self):
        echoed = self.server._initialize({"protocolVersion": "2024-11-05"})  # noqa: SLF001
        self.assertEqual(echoed["protocolVersion"], "2024-11-05")
        self.assertEqual(echoed["serverInfo"]["name"], "pdf")
        self.assertIn("tools", echoed["capabilities"])
        unknown = self.server._initialize({"protocolVersion": "1999-01-01"})  # noqa: SLF001
        self.assertEqual(unknown["protocolVersion"], "2025-06-18")

    def test_an_unknown_tool_is_answered_as_a_tool_error_naming_the_name(self):
        result = self.server._call_tool({"name": "pdf_delete_everything", "arguments": {}})  # noqa: SLF001
        expect_error(result, "pdf_delete_everything")

    def test_a_success_carries_both_the_summary_text_and_the_structured_content(self):
        result = call("server_info", {})
        self.assertIn("server_info: pdf", text_of(result))
        self.assertEqual(json.loads(text_of(result).split("\n", 1)[1])["name"], "pdf")
        self.assertEqual(result["structuredContent"]["name"], "pdf")


# -- the real process ------------------------------------------------------------------------------

class StdioProcessTest(WorkspaceTest):
    """Drives `main.py` as the gateway does: a separate process speaking MCP over stdio."""

    def _session(self, messages, environment=None):
        entry = os.path.join(PACKAGE, "main.py")
        env = dict(os.environ)
        if environment:
            env.update(environment)
        process = subprocess.Popen(
            [sys.executable, entry], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, env=env)
        payload = "".join(json.dumps(message) + "\n" for message in messages).encode("utf-8")
        out, err = process.communicate(payload, timeout=120)
        replies = [json.loads(line) for line in out.decode("utf-8").splitlines() if line.strip()]
        return replies, err.decode("utf-8", "replace"), process.returncode

    def test_a_full_stdio_session_initializes_lists_and_calls(self):
        path = self.report()
        replies, stderr, code = self._session([
            {"jsonrpc": "2.0", "id": 1, "method": "initialize",
             "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
            {"jsonrpc": "2.0", "id": 3, "method": "tools/call",
             "params": {"name": "pdf_info", "arguments": {"path": path}}},
            {"jsonrpc": "2.0", "id": 4, "method": "ping"},
        ])
        self.assertEqual(code, 0, stderr)
        self.assertEqual([reply["id"] for reply in replies], [1, 2, 3, 4])
        self.assertEqual(replies[0]["result"]["serverInfo"]["name"], "pdf")
        self.assertEqual(len(replies[1]["result"]["tools"]), 4)
        self.assertEqual(replies[2]["result"]["structuredContent"]["pageCount"], 4)
        self.assertIn("ready on stdio", stderr)

    def test_stdout_carries_json_rpc_and_nothing_else(self):
        replies, _stderr, code = self._session([
            {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
             "params": {"name": "pdf_info", "arguments": {"path": self.report()}}},
        ])
        self.assertEqual(code, 0)
        self.assertEqual(len(replies), 1)

    def test_a_malformed_frame_and_an_unknown_method_are_answered_not_fatal(self):
        entry = os.path.join(PACKAGE, "main.py")
        process = subprocess.Popen([sys.executable, entry], stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        payload = (b"{not json}\n"
                   + json.dumps({"jsonrpc": "2.0", "id": 7, "method": "no/such/method"}).encode("utf-8") + b"\n"
                   + json.dumps({"jsonrpc": "2.0", "id": 8, "method": "tools/list"}).encode("utf-8") + b"\n")
        out, _err = process.communicate(payload, timeout=120)
        replies = [json.loads(line) for line in out.decode("utf-8").splitlines() if line.strip()]
        self.assertEqual(replies[0]["error"]["code"], -32700)
        self.assertEqual(replies[1]["error"]["code"], -32601)
        self.assertEqual(len(replies[2]["result"]["tools"]), 4)
        self.assertEqual(process.returncode, 0)


if __name__ == "__main__":
    unittest.main()
