import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

path = sys.argv[1]
ns = {
    "main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "rel": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "pkg": "http://schemas.openxmlformats.org/package/2006/relationships",
}

def col_index(ref):
    letters = re.match(r"[A-Z]+", ref or "")
    if not letters:
        return 0
    value = 0
    for char in letters.group(0):
        value = value * 26 + ord(char) - 64
    return value - 1

def cell_value(cell, shared):
    kind = cell.attrib.get("t")
    if kind == "inlineStr":
        return "".join(node.text or "" for node in cell.findall(".//main:t", ns))
    node = cell.find("main:v", ns)
    if node is None or node.text is None:
        return ""
    value = node.text
    if kind == "s":
        try:
            return shared[int(value)]
        except (ValueError, IndexError):
            return ""
    if kind == "b":
        return value == "1"
    try:
        number = float(value)
        return int(number) if number.is_integer() else number
    except ValueError:
        return value

with zipfile.ZipFile(path) as book:
    shared = []
    try:
        strings = ET.fromstring(book.read("xl/sharedStrings.xml"))
        shared = ["".join(t.text or "" for t in si.findall(".//main:t", ns)) for si in strings.findall("main:si", ns)]
    except KeyError:
        pass
    workbook = ET.fromstring(book.read("xl/workbook.xml"))
    rels = ET.fromstring(book.read("xl/_rels/workbook.xml.rels"))
    targets = {r.attrib["Id"]: r.attrib["Target"] for r in rels.findall("pkg:Relationship", ns)}
    sheets = {}
    for sheet in workbook.findall(".//main:sheet", ns):
        name = sheet.attrib["name"]
        rid = sheet.attrib[f"{{{ns['rel']}}}id"]
        target = targets[rid].lstrip("/")
        if not target.startswith("xl/"):
            target = "xl/" + target
        root = ET.fromstring(book.read(target))
        rows = []
        for row in root.findall(".//main:sheetData/main:row", ns):
            cells = {}
            next_col = 0
            for cell in row.findall("main:c", ns):
                # Some SAP exports omit the cell reference; those cells follow the previous one.
                ref = cell.attrib.get("r", "")
                index = col_index(ref) if re.match(r"[A-Z]+", ref) else next_col
                cells[index] = cell_value(cell, shared)
                next_col = index + 1
            if cells:
                rows.append([cells.get(i, "") for i in range(max(cells) + 1)])
            else:
                rows.append([])
        sheets[name] = rows
    print(json.dumps(sheets, ensure_ascii=False, separators=(",", ":")))
