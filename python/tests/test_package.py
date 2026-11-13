"""Tests for the volto name-reservation Python package.

Stdlib ``unittest`` only: no pip, no network, no third-party dependencies.

Run them with::

    cd python && python3 -m unittest discover -s tests -v
"""

import ast
import io
import ipaddress
import json
import os
import re
import subprocess
import sys
import tempfile
import tokenize
import unittest
from pathlib import Path

try:  # Python >= 3.11
    import tomllib
except ImportError:  # pragma: no cover - Python < 3.11
    tomllib = None


TOMLLIB_SKIP = (
    "tomllib is only available on Python 3.11+; skipping the pyproject.toml checks"
)

# <repo>/python/tests/test_package.py -> <repo>/python. The package is located
# through the file location of this test, never through the current directory.
PYTHON_DIR = Path(__file__).resolve().parent.parent
PACKAGE_DIR = PYTHON_DIR / "volto"
PYPROJECT_PATH = PYTHON_DIR / "pyproject.toml"

# Keep the working tree free of bytecode caches: the import side-effect test
# asserts that importing the package does not write a single file.
sys.dont_write_bytecode = True

if str(PYTHON_DIR) not in sys.path:
    sys.path.insert(0, str(PYTHON_DIR))

import volto  # noqa: E402  (the path setup above has to happen first)


# --------------------------------------------------------------------------
# pyproject.toml helpers
# --------------------------------------------------------------------------


def read_pyproject():
    """Parse ``python/pyproject.toml`` (requires Python 3.11+)."""
    with PYPROJECT_PATH.open("rb") as handle:
        return tomllib.load(handle)


VERSION_RE = re.compile(r"^(\d+)(?:\.(\d+))?(?:\.(\d+))?$")
SPECIFIER_RE = re.compile(r"(>=|<=|==|!=|~=|>|<)\s*(\d+(?:\.\d+)*)")


def parse_version(text):
    """Turn ``"3.9"`` into ``(3, 9)``.

    The number of components is kept as written, so that ``"3.9"`` and
    ``"3.9.0"`` can be compared the way PEP 440 compares them.
    """
    match = VERSION_RE.match(text.strip())
    if not match:
        raise ValueError(f"not a plain version number: {text!r}")
    parts = [part for part in match.groups() if part is not None]
    return tuple(int(part) for part in parts)


def parse_specifier(specifier):
    """Split a ``requires-python`` string into ``(operator, version)`` clauses."""
    clauses = []
    for operator, version in SPECIFIER_RE.findall(specifier or ""):
        clauses.append((operator, parse_version(version)))
    return clauses


def version_matches(version, operator, bound):
    """Evaluate one specifier clause against *version*."""
    size = len(bound)
    if operator == ">=":
        return version[:size] >= bound
    if operator == ">":
        return version[:size] > bound
    if operator == "<=":
        return version[:size] <= bound
    if operator == "<":
        return version[:size] < bound
    if operator == "==":
        return version[:size] == bound
    if operator == "!=":
        return version[:size] != bound
    if operator == "~=":
        # Compatible release: >= X.Y, and the X part must not change.
        return version[:size] >= bound and version[: size - 1] == bound[: size - 1]
    raise ValueError(f"unsupported version operator: {operator!r}")


# --------------------------------------------------------------------------
# "what does the code need" helpers
# --------------------------------------------------------------------------


def _dotted_names(source):
    """Identifiers and dotted expressions used by *source*.

    Strings and comments are ignored, so a docstring that merely mentions an
    API does not raise the required Python version.  The returned sets contain
    plain names (``tomllib``) as well as dotted ones (``str.removeprefix``).
    """
    names = set()
    dotted = set()
    attributes = set()
    chain = []
    previous = None
    readline = io.StringIO(source).readline
    for token in tokenize.generate_tokens(readline):
        if token.type == tokenize.NAME:
            if previous is not None and previous.type == tokenize.OP and previous.string == ".":
                chain.append(token.string)
            else:
                chain = [token.string]
            names.add(token.string)
            dotted.add(".".join(chain))
            if len(chain) > 1:
                attributes.add(chain[-1])
        elif token.type in (
            tokenize.NL,
            tokenize.NEWLINE,
            tokenize.INDENT,
            tokenize.DEDENT,
            tokenize.COMMENT,
            tokenize.ENCODING,
        ):
            continue
        else:
            if not (token.type == tokenize.OP and token.string == "."):
                chain = []
            previous = token
    return names, dotted, attributes


# Stdlib modules / attributes that only exist from a given release onwards.
# ("name" matches a plain identifier, "dotted" matches ``module.attribute``,
# "attribute" matches any attribute name, e.g. ``value.removeprefix(...)``).
STDLIB_MINIMUMS = (
    ((3, 8), "importlib.metadata", "dotted"),
    ((3, 9), "zoneinfo", "name"),
    ((3, 9), "graphlib", "name"),
    ((3, 9), "str.removeprefix", "dotted"),
    ((3, 9), "str.removesuffix", "dotted"),
    ((3, 9), "functools.cache", "dotted"),
    ((3, 9), "removeprefix", "attribute"),
    ((3, 9), "removesuffix", "attribute"),
    ((3, 10), "itertools.pairwise", "dotted"),
    ((3, 10), "int.bit_count", "dotted"),
    ((3, 10), "bit_count", "attribute"),
    ((3, 10), "pairwise", "attribute"),
    ((3, 11), "tomllib", "name"),
    ((3, 11), "enum.StrEnum", "dotted"),
    ((3, 11), "asyncio.TaskGroup", "dotted"),
)


def _annotations(tree):
    """Yield every annotation node of *tree*."""
    for node in ast.walk(tree):
        annotation = getattr(node, "annotation", None)
        if annotation is not None:
            yield annotation
        returns = getattr(node, "returns", None)
        if returns is not None:
            yield returns


def _annotation_minimum(annotation):
    """Minimum Python version needed to evaluate *annotation* at runtime."""
    needed = (3, 0)
    for node in ast.walk(annotation):
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
            # PEP 604 unions (``str | None``) are evaluated at runtime in 3.10+.
            needed = max(needed, (3, 10))
        elif isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name):
            if node.value.id in {"list", "dict", "set", "tuple", "frozenset", "type"}:
                # PEP 585 builtin generics (``list[str]``) need Python 3.9+.
                needed = max(needed, (3, 9))
    return needed


def minimum_grammar_version(source):
    """Lowest Python 3 grammar level that accepts *source*."""
    for minor in range(4, sys.version_info[1] + 1):
        try:
            ast.parse(source, feature_version=(3, minor))
        except SyntaxError:
            continue
        except ValueError:  # pragma: no cover - feature_version out of range
            break
        return (3, minor)
    return sys.version_info[:2]


def minimum_runtime_version(source):
    """Minimum Python version needed to run *source*."""
    needed = (3, 0)
    tree = ast.parse(source)
    for node in ast.walk(tree):
        if isinstance(node, ast.Match):
            needed = max(needed, (3, 10))
        elif isinstance(node, ast.NamedExpr):
            needed = max(needed, (3, 8))
    for annotation in _annotations(tree):
        needed = max(needed, _annotation_minimum(annotation))
    names, dotted, attributes = _dotted_names(source)
    for version, key, kind in STDLIB_MINIMUMS:
        if kind == "name":
            found = key in names
        elif kind == "dotted":
            found = key in dotted
        else:
            found = key in attributes
        if found:
            needed = max(needed, version)
    return needed


def minimum_python_version_for_sources(paths):
    """Minimum Python version able to import all *paths*."""
    needed = (3, 4)
    for path in paths:
        source = path.read_text(encoding="utf-8")
        needed = max(needed, minimum_grammar_version(source))
        needed = max(needed, minimum_runtime_version(source))
    return needed


# --------------------------------------------------------------------------
# docstring helpers: host names, IP addresses and credentials
# --------------------------------------------------------------------------

# The upstream project URL is the only host that may be referenced. Everything
# else (internal services, staging boxes, tunnels, ...) must not ship inside a
# published package.
ALLOWED_HOSTS = frozenset(
    {
        "github.com",
        "www.github.com",
        "raw.githubusercontent.com",
        "gitlab.com",
        "bitbucket.org",
        "pypi.org",
        "python.org",
        "docs.python.org",
        "readthedocs.io",
        "opensource.org",
        "spdx.org",
    }
)

HOSTNAME_RE = re.compile(
    r"\b(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}\b"
)

# Words such as "README.md" look like a host name but are file names.
FILE_SUFFIXES = frozenset(
    {
        "cfg", "css", "gif", "gz", "html", "ini", "jpeg", "jpg", "js", "json",
        "jsx", "lock", "log", "md", "png", "py", "pyi", "rst", "svg", "tar",
        "toml", "ts", "tsx", "txt", "whl", "xml", "yaml", "yml",
    }
)

IP_CANDIDATE_RE = re.compile(r"\b[0-9A-Fa-f:.]+\b")
URL_RE = re.compile(r"\b(?:https?|ftp|ftps|ssh|git)://[^\s'\"<>)\]]+")

SECRET_PATTERNS = (
    ("GitHub token", r"\bgh[pousr]_[A-Za-z0-9]{16,}\b"),
    ("GitHub fine-grained token", r"\bgithub_pat_[A-Za-z0-9_]{20,}\b"),
    ("OpenAI-style API key", r"\bsk-[A-Za-z0-9_-]{16,}\b"),
    ("AWS access key id", r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
    ("Google API key", r"\bAIza[0-9A-Za-z_-]{35}\b"),
    ("Slack token", r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b"),
    ("PyPI upload token", r"\bpypi-[A-Za-z0-9_-]{16,}\b"),
    ("private key block", r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    ("JSON web token", r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b"),
    ("long hex secret", r"\b[0-9A-Fa-f]{32,}\b"),
    (
        "credential assignment",
        r"(?i)\b(?:api[_-]?key|secret|token|password|passwd|pwd|credential)s?\b"
        r"\s*[:=]\s*[\"']?[^\s\"',;)]{6,}",
    ),
)


def _host_of(url):
    """Host part of *url* (without credentials and port)."""
    remainder = url.split("://", 1)[-1]
    remainder = remainder.split("/", 1)[0]
    if "@" in remainder:
        remainder = remainder.rsplit("@", 1)[-1]
    return remainder.split(":", 1)[0].strip(".")


def _has_credentials(url):
    remainder = url.split("://", 1)[-1]
    authority = remainder.split("/", 1)[0]
    return "@" in authority and ":" in authority.split("@", 1)[0]


def find_sensitive_strings(text):
    """Return a list of host names / IP addresses / tokens found in *text*."""
    findings = []

    for match in HOSTNAME_RE.finditer(text):
        host = match.group(0)
        suffix = host.rsplit(".", 1)[-1].lower()
        if suffix in FILE_SUFFIXES:
            continue  # a file name, not a host name
        if host.lower() in ALLOWED_HOSTS:
            continue
        findings.append(f"host name {host!r}")

    for match in IP_CANDIDATE_RE.finditer(text):
        candidate = match.group(0).strip(".")
        try:
            address = ipaddress.ip_address(candidate)
        except ValueError:
            continue
        if address.is_unspecified:
            continue  # "::" / "0.0.0.0" placeholders
        findings.append(f"IP address {candidate!r}")

    for label, pattern in SECRET_PATTERNS:
        for match in re.finditer(pattern, text):
            findings.append(f"{label} {match.group(0)!r}")

    for match in URL_RE.finditer(text):
        url = match.group(0)
        if not url.lower().startswith("https://"):
            findings.append(f"non-HTTPS URL {url!r}")
        elif _has_credentials(url):
            findings.append(f"URL with credentials {url!r}")
        elif _host_of(url).lower() not in ALLOWED_HOSTS:
            findings.append(f"URL to unknown host {url!r}")

    return findings


# --------------------------------------------------------------------------
# import side-effect probe
# --------------------------------------------------------------------------

# The probe installs an audit hook before importing the package: any attempt to
# write a file, to touch the network or to spawn a process is recorded.
SIDEEFFECT_PROBE = r'''
import json
import os
import sys

WRITE_EVENTS = {
    "os.mkdir", "os.rmdir", "os.remove", "os.rename", "os.replace",
    "os.link", "os.symlink", "os.truncate", "os.chmod", "os.chown",
    "shutil.copyfile", "shutil.copytree", "shutil.move", "shutil.rmtree",
}
NETWORK_EVENTS = {
    "socket.__new__", "socket.connect", "socket.bind", "socket.getaddrinfo",
    "socket.gethostbyname", "socket.sendto", "ssl.wrap_socket",
    "urllib.Request", "http.client.connect", "http.client.send",
    "ftplib.connect", "smtplib.connect", "imaplib.open", "poplib.connect",
}
EXEC_EVENTS = {
    "subprocess.Popen", "os.system", "os.exec", "os.posix_spawn", "os.fork",
}

observations = []


def audit(event, args):
    if event == "open":
        path = str(args[0])
        mode = args[1] if len(args) > 1 else ""
        flags = args[2] if len(args) > 2 else 0
        writing = bool(mode) and any(flag in mode for flag in "wax+")
        writing = writing or bool(
            flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND)
        )
        if writing:
            observations.append(["file-write", path, str(mode), str(flags)])
        return
    if event in WRITE_EVENTS:
        observations.append(["file-write", event, repr(args)[:200]])
    elif event in NETWORK_EVENTS:
        observations.append(["network", event, repr(args)[:200]])
    elif event in EXEC_EVENTS:
        observations.append(["exec", event, repr(args)[:200]])


sys.addaudithook(audit)

error = None
version = None
try:
    import volto
except BaseException as exc:  # the probe always has to report what it saw
    error = "{0}: {1}".format(type(exc).__name__, exc)
else:
    version = volto.__version__

print(
    json.dumps(
        {"observations": observations, "version": version, "error": error}
    )
)
'''


class PackageMetadataTest(unittest.TestCase):
    """The package metadata in pyproject.toml has to match the package."""

    @unittest.skipIf(tomllib is None, TOMLLIB_SKIP)
    def test_version_matches_pyproject_version(self):
        project = read_pyproject().get("project", {})
        self.assertIn("version", project, "pyproject.toml must declare a version")
        self.assertEqual(
            volto.__version__,
            project["version"],
            "volto.__version__ must match the version in pyproject.toml",
        )

    def test_all_lists_exactly_version(self):
        self.assertTrue(hasattr(volto, "__all__"), "the package must define __all__")
        self.assertEqual(list(volto.__all__), ["__version__"])
        for name in volto.__all__:
            self.assertTrue(hasattr(volto, name), f"__all__ exports missing {name!r}")

    @unittest.skipIf(tomllib is None, TOMLLIB_SKIP)
    def test_requires_python_matches_code_requirements(self):
        project = read_pyproject().get("project", {})
        self.assertIn("requires-python", project, "pyproject.toml must declare requires-python")
        specifier = project["requires-python"]
        clauses = parse_specifier(specifier)
        self.assertTrue(clauses, f"cannot parse requires-python={specifier!r}")

        lower_bounds = [
            version for operator, version in clauses if operator in (">=", ">", "==", "~=")
        ]
        self.assertTrue(
            lower_bounds,
            f"requires-python={specifier!r} must declare a lower bound",
        )
        declared_minimum = min(lower_bounds)

        sources = sorted(PACKAGE_DIR.glob("*.py"))
        self.assertTrue(sources, "the package directory must contain Python sources")
        needed = minimum_python_version_for_sources(sources)

        self.assertGreaterEqual(
            declared_minimum[:2],
            needed[:2],
            f"requires-python={specifier!r} is too low: the sources need Python "
            f"{needed[0]}.{needed[1]}",
        )
        for operator, version in clauses:
            self.assertTrue(
                version_matches(sys.version_info[:3], operator, version),
                f"the running interpreter {sys.version.split()[0]} does not satisfy "
                f"requires-python={specifier!r}",
            )

    @unittest.skipIf(tomllib is None, TOMLLIB_SKIP)
    def test_wheel_target_packages_is_volto(self):
        targets = (
            read_pyproject()
            .get("tool", {})
            .get("hatch", {})
            .get("build", {})
            .get("targets", {})
        )
        self.assertIn("wheel", targets, "pyproject.toml must define the wheel target")
        self.assertEqual(targets["wheel"].get("packages"), ["volto"])

    @unittest.skipIf(tomllib is None, TOMLLIB_SKIP)
    def test_readme_named_in_pyproject_exists(self):
        project = read_pyproject().get("project", {})
        self.assertIn("readme", project, "pyproject.toml must declare a readme")
        readme = project["readme"]
        if isinstance(readme, dict):
            readme = readme.get("file")
        self.assertIsInstance(readme, str, "readme must be a file name")
        readme_path = (PYTHON_DIR / readme).resolve()
        self.assertTrue(
            readme_path.is_file(),
            f"the readme {readme!r} declared in pyproject.toml does not exist",
        )
        self.assertTrue(
            readme_path.read_text(encoding="utf-8").strip(),
            f"the readme {readme!r} is empty",
        )


class ModuleDocstringTest(unittest.TestCase):
    """The module docstring must describe the project and stay harmless."""

    def test_docstring_mentions_the_project(self):
        docstring = volto.__doc__
        self.assertIsInstance(docstring, str, "the module must have a docstring")
        self.assertIn(
            "volto",
            docstring.lower(),
            "the docstring must mention the project name",
        )

    def test_docstring_has_no_hostnames_ips_or_tokens(self):
        docstring = volto.__doc__ or ""
        findings = find_sensitive_strings(docstring)
        self.assertEqual(
            findings,
            [],
            "the docstring must not contain host names, IP addresses or tokens: "
            + "; ".join(findings),
        )


class ImportSideEffectTest(unittest.TestCase):
    """Importing the package must not do anything besides defining names."""

    def test_import_has_no_side_effects(self):
        with tempfile.TemporaryDirectory() as workdir:
            env = dict(os.environ)
            env["PYTHONPATH"] = str(PYTHON_DIR)
            env["PYTHONDONTWRITEBYTECODE"] = "1"
            env["PYTHONNOUSERSITE"] = "1"
            env.pop("PYTHONSTARTUP", None)

            package_before = sorted(path.name for path in PACKAGE_DIR.iterdir())
            workdir_before = sorted(os.listdir(workdir))

            completed = subprocess.run(
                [sys.executable, "-B", "-c", SIDEEFFECT_PROBE],
                cwd=workdir,
                env=env,
                capture_output=True,
                text=True,
                timeout=120,
            )
            self.assertEqual(
                completed.returncode,
                0,
                f"the import probe failed:\n{completed.stderr}",
            )
            payload = json.loads(completed.stdout.strip().splitlines()[-1])

            self.assertIsNone(
                payload["error"],
                f"importing the package raised {payload['error']}",
            )
            self.assertEqual(
                payload["observations"],
                [],
                "importing the package must not write files, use the network or "
                "spawn processes",
            )
            self.assertEqual(payload["version"], volto.__version__)
            self.assertEqual(
                sorted(os.listdir(workdir)),
                workdir_before,
                "importing the package must not create files in the working directory",
            )
            self.assertEqual(
                sorted(path.name for path in PACKAGE_DIR.iterdir()),
                package_before,
                "importing the package must not create files in the package directory",
            )


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
