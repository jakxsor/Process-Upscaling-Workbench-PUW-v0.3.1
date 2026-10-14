#!/usr/bin/env python3
"""Local Python web app for annotating protocol blocks and grouping phenomena."""

import argparse
import gzip
import json
import os
import threading
import collections
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

if __package__:
    from .pubchem_lookup import lookup_pubchem
else:
    from pubchem_lookup import lookup_pubchem


def _export_renderer(kind):
    """Import an export renderer on first use.

    python-pptx and openpyxl are only needed by the two export endpoints; the
    workbench itself is browser code and runs without them. Importing them at
    module load made a missing optional dependency fail the whole application
    instead of just the export button that needs it.
    """
    try:
        if kind == "pptx":
            if __package__:
                from .pptx_renderer import render_flowsheet_pptx as renderer
            else:
                from pptx_renderer import render_flowsheet_pptx as renderer
        else:
            if __package__:
                from .xlsx_renderer import render_lci_workbook_xlsx as renderer
            else:
                from xlsx_renderer import render_lci_workbook_xlsx as renderer
    except ImportError as exc:
        package = "python-pptx" if kind == "pptx" else "openpyxl"
        raise RuntimeError(
            f"{package} is not installed, so this export is unavailable. "
            "Install it with: python3 -m pip install -r upscaling_pipeline_tool/requirements.txt"
        ) from exc
    return renderer

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
MAX_REQUEST_BYTES = 12 * 1024 * 1024
# A PubChem lookup carries a compound name, not a project: a small body limit keeps a slow-body
# client from holding a thread on that route.
PUBCHEM_MAX_REQUEST_BYTES = 4 * 1024
# Each lookup fans out to up to four PubChem requests and PubChem throttles per source IP, so an
# unauthenticated caller could get the shared egress address blocked for everyone. A per-client
# budget and a result cache keep one client from spending the whole allowance.
PUBCHEM_RATE_LIMIT = 30
PUBCHEM_RATE_WINDOW_S = 60.0
PUBCHEM_CACHE_SIZE = 512
PUBCHEM_CACHE_TTL_S = 24 * 3600.0
_PUBCHEM_LOCK = threading.Lock()
_PUBCHEM_HITS = {}
_PUBCHEM_CACHE = collections.OrderedDict()


def _pubchem_allowed(client_key, now=None):
    now = time.monotonic() if now is None else now
    with _PUBCHEM_LOCK:
        stale = [key for key, hits in _PUBCHEM_HITS.items() if not hits or hits[-1] < now - PUBCHEM_RATE_WINDOW_S]
        for key in stale:
            del _PUBCHEM_HITS[key]
        hits = [stamp for stamp in _PUBCHEM_HITS.get(client_key, []) if stamp >= now - PUBCHEM_RATE_WINDOW_S]
        if len(hits) >= PUBCHEM_RATE_LIMIT:
            _PUBCHEM_HITS[client_key] = hits
            return False
        hits.append(now)
        _PUBCHEM_HITS[client_key] = hits
        return True


def _pubchem_cached(cache_key, compute, now=None):
    now = time.monotonic() if now is None else now
    with _PUBCHEM_LOCK:
        hit = _PUBCHEM_CACHE.get(cache_key)
        if hit is not None and hit[0] > now:
            _PUBCHEM_CACHE.move_to_end(cache_key)
            return hit[1]
    result = compute()
    # Only successful answers are kept: a transient PubChem failure should not be served for a day.
    if isinstance(result, dict) and result.get("ok", True):
        with _PUBCHEM_LOCK:
            _PUBCHEM_CACHE[cache_key] = (now + PUBCHEM_CACHE_TTL_S, result)
            _PUBCHEM_CACHE.move_to_end(cache_key)
            while len(_PUBCHEM_CACHE) > PUBCHEM_CACHE_SIZE:
                _PUBCHEM_CACHE.popitem(last=False)
    return result


# Every script is a same-origin file and nothing is fetched from another origin, so the policy
# can be strict. Inline style attributes exist in the rendered HTML, hence 'unsafe-inline' for
# styles only; scripts stay file-only, which also defuses any markup that slips through escaping.
SECURITY_HEADERS = (
    ("X-Content-Type-Options", "nosniff"),
    ("X-Frame-Options", "DENY"),
    ("Referrer-Policy", "no-referrer"),
    (
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
        "connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    ),
)


def _read_static(filename):
    with open(os.path.join(STATIC_DIR, filename), "r", encoding="utf-8") as f:
        return f.read()


# Static files are served gzip-compressed when the browser accepts it. app.js alone is close to a
# megabyte, which is fine on localhost and slow on the LAN or a remote link; compression brings
# the whole bundle under a fifth of its size. Compressed bodies are cached by (name, mtime, size)
# so a file is compressed once per edit, not once per request; the no-cache headers stay, so an
# edited file still reaches the browser on the next load.
GZIP_MIN_BYTES = 1024
_GZIP_CACHE: dict = {}
_GZIP_LOCK = threading.Lock()


def _gzip_body(cache_key, body):
    with _GZIP_LOCK:
        hit = _GZIP_CACHE.get(cache_key)
        if hit is not None and hit[0] == len(body):
            return hit[1]
    compressed = gzip.compress(body, compresslevel=6, mtime=0)
    with _GZIP_LOCK:
        _GZIP_CACHE[cache_key] = (len(body), compressed)
    return compressed


def _accepts_gzip(headers):
    accepted = headers.get("Accept-Encoding", "")
    for token in accepted.split(","):
        parts = [part.strip() for part in token.split(";")]
        if not parts or parts[0].lower() != "gzip":
            continue
        for param in parts[1:]:
            if param.lower().startswith("q="):
                try:
                    return float(param[2:]) > 0
                except ValueError:
                    return False
        return True
    return False


def _decode_json_payload(raw_body):
    try:
        payload = json.loads(raw_body.decode("utf-8"))
    except UnicodeDecodeError as exc:
        raise ValueError("Request body must be valid UTF-8 JSON.") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"Request body must be valid JSON: {exc.msg}.") from exc
    if not isinstance(payload, dict):
        raise ValueError("Request JSON must be an object.")
    return payload


APP_HTML = r"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Process Upscaling Workbench</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/style.css">
  <link rel="stylesheet" href="/flowsheet.css">
</head>
<body>
  <header>
    <div class="brand">
      <span class="brand-mark" aria-hidden="true">PUW</span>
      <div>
        <h1>Process Upscaling Workbench</h1>
        <div class="subtitle">From laboratory protocol to a structured industrial flowsheet.</div>
      </div>
    </div>
    <div class="row">
      <button id="undoAction" title="Undo last change (Ctrl/Cmd+Z)" disabled>↶ Undo</button>
      <div class="header-dropdown work-dropdown">
        <button id="workMenuToggle" aria-haspopup="true" aria-expanded="false" title="Save, restore, import, or export project work">File ▾</button>
        <div id="workMenu" class="header-dropdown-menu saved-work-menu" hidden role="menu">
          <button id="saveLocalProject" class="primary" role="menuitem" title="Save the current project state in this browser">Save Snapshot</button>
          <button id="restoreAutosaveProject" role="menuitem" title="Restore the last autosaved state from this browser">Restore Autosave</button>
          <button id="importJsonProject" role="menuitem" title="Load a previously exported upscaling-project.json file">Import JSON</button>
          <input id="importJsonFile" type="file" accept="application/json,.json" hidden>
          <button id="exportJson" class="export-json-button" role="menuitem" title="Download the full project data as a JSON file">&#8595; Export JSON</button>
          <button id="exportLciExcel" class="export-json-button" role="menuitem" title="Download an ordered LCI workbook for review and openLCA mapping">&#8595; LCI Excel</button>
          <div id="savedWorkStatus" class="muted small"></div>
          <div id="savedProjectList" class="saved-project-list"></div>
        </div>
      </div>
      <div class="header-dropdown tutorial-dropdown">
        <button id="tutorialMenuToggle" aria-haspopup="true" aria-expanded="false" title="Choose a quick or complete guided tutorial">Tutorial ▾</button>
        <div id="tutorialMenu" class="header-dropdown-menu" hidden role="menu">
          <button id="openQuickTutorial" role="menuitem" title="Essential workflow in a few guided steps">Quick tour</button>
          <button id="openFullTutorial" role="menuitem" title="Complete guided workflow with every editing and review step">Full tutorial</button>
        </div>
      </div>
      <div class="header-dropdown">
        <button id="loadExampleToggle" aria-haspopup="true" aria-expanded="false">Load example ▾</button>
        <div id="loadExampleMenu" class="header-dropdown-menu" hidden role="menu">
          <button id="loadSample" role="menuitem" title="SI-derived case with a readability-normalized cyclohexane protocol">Octocrylene Case</button>
          <button id="loadMethylbenzeneCase" role="menuitem" title="Illustrative synthetic case with no literature source: benzyl alcohol acetylation with triethylamine, used to exercise the reaction and separation workflow">3-Reagent Case</button>
          <button id="loadBiodieselCase" role="menuitem" title="Base-catalysed transesterification of vegetable oil to biodiesel. Reaction charges and conditions from Freedman 1984 and Van Gerpen 2005, product limits per EN 14214; downstream splits, losses and times are engineering estimates and each row says so">Biodiesel Case</button>
          <button id="loadBiodieselLutzeCase" role="menuitem" title="The same reaction without its downstream train: build the separation with the Lutze/Garg screening and compare it with the full case">Biodiesel Case, screen with Lutze</button>
        </div>
      </div>
      <button id="openFlowsheet" class="flowsheet-view-button" title="Open the editable flowsheet board generated from the current groups and streams">Flowsheet View</button>
    </div>
  </header>

  <nav id="workflowStepper" class="workflow-stepper" aria-label="Process upscaling workflow steps"></nav>

  <main id="appMain">
    <section class="panel" id="protocolPanel">
      <div class="panel-head source-panel-head">
        <button id="toggleProtocolPanel" class="eye-button" title="Show/hide protocol panel">&#8249;</button>
        <div class="source-panel-head-body">
          <div>
            <h2>Protocol <button class="help-button" data-help-topic="protocol" title="Help for this panel" aria-label="Help for the protocol panel">?</button></h2>
            <span class="step-flag" data-step-flag="1"><span class="step-flag-num">1</span><span class="step-flag-label">Block Creation</span><span class="step-flag-note"></span></span>
            <span class="muted small">Select a passage to create a process block.</span>
          </div>
        </div>
      </div>
      <div class="panel-body stack">
        <div id="sourceProtocolTab" class="source-tab-view stack">
          <details id="sourceTextDetails" class="source-text-details" open>
            <summary><span>Source text</span><span id="sourceTextSummary" class="muted small"></span></summary>
            <textarea id="sourceInput" spellcheck="false" placeholder="Paste or edit the protocol text here, then load it into the annotated text view."></textarea>
            <div class="row">
              <button id="loadTextSide" class="primary">Load Protocol</button>
            </div>
          </details>
          <div class="row">
            <button id="createBlockSide">Create Block</button>
            <button id="clearProject">Clear Blocks</button>
          </div>
          <div id="selectionInfo" class="muted">No active text selection.</div>
          <div id="annotatedText" class="text-surface"></div>
        </div>
      </div>
    </section>

    <section class="panel workflow-panel">
      <div class="panel-head">
        <div class="workflow-title-stack">
          <h2>Process Map</h2>
          <span class="panel-context">Blocks, tasks and material links</span>
        </div>
        <div class="workflow-view-tools" aria-label="Board view controls">
          <button class="help-button" data-help-topic="board" title="Help for the board" aria-label="Help for the board">?</button>
          <div class="header-dropdown">
            <button id="connectionsToggle" aria-haspopup="true" aria-expanded="false" title="Auto-connect groups, or review/remove individual arrows">Connections ▾</button>
            <div id="connectionsMenu" class="header-dropdown-menu connections-dropdown-menu" hidden role="menu">
              <button id="autoConnect" class="primary" title="Connect task groups in text order and add recycle arrows from declared stream destinations">Auto-Connect</button>
              <div id="connectionStatus" class="connection-status"></div>
              <div id="linkSummary"></div>
            </div>
          </div>
          <button id="focusBoard" class="board-focus-button" aria-pressed="false" aria-label="Focus process map" title="Focus map: hide both side panels">⛶</button>
          <details class="header-dropdown board-view-dropdown">
            <summary title="Center, fit, reset, or zoom the process board">View</summary>
            <div class="header-dropdown-menu board-view-menu">
              <button id="toggleCompact" title="Switch group boxes between full detail and compact icon + label view">Compact</button>
              <button id="autoLayout" title="Arrange groups left to right along the declared links; content is unchanged">Auto-arrange</button>
              <div class="menu-divider" role="separator"></div>
              <button id="boardCenter" title="Scroll to and zoom in on the currently selected block or group">Center selection</button>
              <button id="zoomFit" title="Zoom out just enough to fit every block and group on screen">Fit board</button>
              <button id="resetView" title="Scroll back to the top-left corner and reset zoom to the default level">Reset view</button>
              <div class="workflow-zoom-row">
                <button id="zoomOut" title="Zoom out" aria-label="Zoom out">-</button>
                <span id="zoomReadout" class="zoom-readout">100%</span>
                <button id="zoomIn" title="Zoom in" aria-label="Zoom in">+</button>
              </div>
            </div>
          </details>
        </div>
      </div>
      <div class="panel-body">
        <span class="step-flag board-step-flag tip" data-step-flag="3" data-tip="Step 3: group blocks, then assign a unit operation on each group box">
          <span class="step-flag-num">3</span><span class="step-flag-label">Unit Ops &amp; Task Assignment</span><span class="step-flag-note"></span>
        </span>
        <div id="groupFlow" class="group-flow"></div>
        <div id="stepFlowInspector" class="step-flow-inspector empty">
          <span class="step-flag" data-step-flag="4"><span class="step-flag-num">4</span><span class="step-flag-label">Network &amp; MFA</span><span class="step-flag-note"></span></span>
          <div>Select a block to add quantified MFA inputs, outputs, and waste/emission streams.</div>
        </div>
      </div>
    </section>

    <section class="panel" id="inspectorPanel">
      <div class="panel-head">
        <button id="toggleInspector" class="eye-button" title="Show/hide Phenomena/Group panel">&#8250;</button>
        <button class="help-button" data-help-topic="inspector" title="Help for this panel" aria-label="Help for the right-hand panel">?</button>
        <div class="panel-tabs" role="tablist" aria-label="Workflow categories">
          <button class="panel-tab active" data-inspector-tab="inspect" role="tab" title="Steps 1-2: description and phenomena of the selected block"><span class="panel-tab-label">Phenomena</span></button>
          <button class="panel-tab" data-inspector-tab="heuristics" role="tab" title="Step 5: Heuristic rules application"><span class="panel-tab-label">Heuristics</span></button>
          <button class="panel-tab" data-inspector-tab="scale" role="tab" title="Step 6: Preliminary scheduling"><span class="panel-tab-label">Scale-Up</span></button>
        </div>
      </div>
      <div class="panel-body stack">
        <div id="inspectPanelTab" class="tab-view stack">
          <div class="card stack">
            <div>
              <div class="label">Selected Description</div>
              <div id="selectedBlockInfo" class="muted">No block selected.</div>
            </div>
            <div id="blockInspectorFields" class="stack">
              <label>
                <div class="label">Description Text</div>
                <textarea id="blockText" class="description-editor" placeholder="Select or create a block, then refine the extracted description here."></textarea>
              </label>
              <span class="step-flag" data-step-flag="2"><span class="step-flag-num">2</span><span class="step-flag-label">Phenomena Assignment</span><span class="step-flag-note"></span></span>
              <label>
                <div class="label tip" data-tip="A preset assigns a whole set of phenomena; unassigned lets you pick them one by one below">Phenomena Presets</div>
                <select id="behaviorSelect" class="behavior-select"></select>
              </label>
              <div id="behaviorPresetHelp" class="behavior-preset-help muted small"></div>
              <div id="phenomenaGridSection"></div>
            </div>
          </div>

          <details class="card inspector-details">
            <summary>
              <span><strong>Operating Basis</strong><small id="groupPropertiesSummary">Mixture-level data for sizing and energy</small></span>
            </summary>
            <div class="inspector-details-body">
              <div class="muted small">One value for the whole group's mixture - not an automatic average of the project's substances. Density, heat capacity, and viscosity depend on composition and temperature in ways this tool cannot infer from named substances alone, so enter your best estimate (the dominant component's value, a literature mixture value, or a measurement). Pure-component and binary separation properties belong in Substances (right-click the board) or Lutze/Garg instead.</div>
              <div id="groupProperties"></div>
            </div>
          </details>

          <pre id="jsonOut" hidden>{}</pre>

          <div class="card stack">
            <div class="row between">
              <div>
                <div class="label">Data Quality</div>
                <div id="dataReadinessSummary" class="muted small">No project data yet.</div>
              </div>
              <button id="toggleReadiness" class="mini-button">Details</button>
            </div>
            <div id="dataReadinessPanel" hidden></div>
            <div id="dataQualityDetails" class="data-quality-details" hidden>
              <div class="readiness-category">
                <div class="label">Data provenance</div>
                <div class="muted small">How much of the declared stream data is measured, sourced, or assumed.</div>
                <div id="dataProvenanceSummary"></div>
              </div>
              <div class="readiness-category">
                <div class="label">Inventory readiness</div>
                <div id="lcaReadinessSummary" class="muted small">No streams yet.</div>
                <div id="lcaReadinessPanel" hidden></div>
              </div>
            </div>
          </div>
        </div>

        <div id="heuristicsPanelTab" class="tab-view scale-tab" hidden>
          <section class="card stack scale-sticky-card">
            <div class="scale-run-row">
              <div>
                <div class="label">Heuristic Rules</div>
                <div class="muted small">Pre-scale screening before numerical scale-up.</div>
              </div>
              <button id="openProcessCheck" class="primary">Apply Rules</button>
              <span class="muted small">process checker; external API optional</span>
            </div>
          </section>

          <div class="scale-scroll-body stack">
            <section class="card stack">
              <div id="heuristicsPanel"></div>
              <div class="card-divider">
                <div class="label">Review Results</div>
                <div class="muted small">Conflicts and missing information detected before scale-up.</div>
              </div>
              <div id="heuristicRuleCheckPanel" class="rule-results"></div>
            </section>
          </div>
        </div>

        <div id="scalePanelTab" class="tab-view scale-tab" hidden>
          <section class="card stack scale-sticky-card">
            <div class="scale-run-row">
              <div>
                <div class="label">Scale-Up Setup</div>
                <div class="muted small">Set the production target; existing MFA, reaction, and timetable data provide the calculation basis.</div>
              </div>
              <button id="refineProject" class="primary">Review Gaps</button>
            </div>
            <div id="scaleQuickPanel"></div>
          </section>

          <div class="scale-scroll-body stack">
            <section class="card stack">
              <div>
                <div class="label">Scale-Up Decision</div>
                <div class="muted small">Production plan, preliminary equipment sizing, and the most important gaps.</div>
              </div>
              <div id="scaleBasisPanel"></div>
            </section>
          </div>
        </div>

      </div>
    </section>
  </main>

  <footer class="dev-notice" aria-label="Development notice">
    This tool is under development. If you encounter any issues, contact
    <a href="mailto:jacopo.sorani@empa.ch">jacopo.sorani@empa.ch</a>.
  </footer>

  <div id="blockMenu" class="context-menu" hidden>
    <div class="label">Arrows</div>
    <button id="ctxStartBlockConnection" class="primary">Start Arrow From This Block</button>
    <button id="ctxRemoveBlockLinks">Remove Arrows For This Block</button>

    <div class="label" style="margin-top:10px">Task Grouping (Step 3) — keeps blocks separate</div>
    <button id="ctxCombine" class="primary" title="Bundle the selected blocks under one new task; the blocks themselves are unchanged">Group Into New Task</button>
    <button id="ctxNewGroup" title="Put only this block into its own new task group, on its own.">Put This Block In Its Own Task</button>
    <select id="ctxGroupSelect"></select>
    <button id="ctxAssignGroup" title="Add the selected blocks to the task group chosen above">Assign To Selected Task Above</button>
    <button id="ctxRemoveFromGroup" title="Return this block to the draft state; the block itself is unchanged">Remove From Task Group</button>

    <div class="label" style="margin-top:10px">Scale-Up</div>
    <button id="ctxSplitBlockGroup" title="Split the task group that contains this block into parallel units">Split This Task Group</button>

    <div class="label" style="margin-top:10px">Block Editing (Step 1) — changes the blocks themselves</div>
    <button id="ctxMergeBlocks" title="Fuse adjacent blocks into one; cannot be split back automatically">Merge Into One Block</button>
    <button id="ctxDeleteBlock" class="danger-button">Delete Block</button>
  </div>

  <div id="groupMenu" class="context-menu" hidden>
    <div class="label">Group Actions</div>
    <button id="ctxStartConnection" class="primary">Start Arrow From This Group</button>
    <button id="ctxRemoveLinks">Remove Arrows For This Group</button>
    <button id="ctxAddManualBlockToGroup">Add Empty Block To This Task</button>
    <div class="label" style="margin-top:10px">Scale-Up</div>
    <button id="ctxSplitGroup" title="Split into N parallel units, each with 1/N of the material flow">Split Into Parallel Units</button>
  </div>

  <div id="streamMenu" class="context-menu" hidden>
    <div class="label">Stream Actions</div>
    <button id="ctxEditStream" class="primary">Edit</button>
    <button id="ctxDeleteStream">Delete</button>
  </div>

  <div id="pubchemResolveModal" class="modal-backdrop" hidden>
    <section class="modal-card pubchem-resolve-panel" role="dialog" aria-modal="true" aria-labelledby="pubchemResolveTitle">
      <div class="modal-head">
        <div>
          <h2 id="pubchemResolveTitle">Resolve PubChem Compound</h2>
          <p id="pubchemResolveSubtitle">Search manually by compound name or CAS number.</p>
        </div>
        <button id="closePubchemResolve" class="modal-icon-button" title="Close" aria-label="Close">&times;</button>
      </div>
      <div id="pubchemResolveBody" class="modal-body"></div>
    </section>
  </div>

  <div id="textSelectionMenu" class="context-menu" hidden>
    <div class="label">Block Creation</div>
    <button id="ctxCreateBlockFromText" class="primary">Create Block From Selection</button>
    <button id="ctxCreateManualBlock">New Empty Block</button>
    <div class="label" style="margin-top:10px">Project Data</div>
    <button id="ctxOpenSubstances">Substances&hellip;</button>
  </div>

  <div id="substancesModal" class="modal-backdrop" hidden>
    <section class="modal-card substances-modal-panel" role="dialog" aria-modal="true" aria-labelledby="substancesModalTitle">
      <div class="modal-head">
        <div>
          <h2 id="substancesModalTitle">Substances</h2>
          <p id="projectSubstancesSummary">No substances declared yet.</p>
        </div>
        <button id="closeSubstancesModal" class="modal-icon-button" title="Close" aria-label="Close">&times;</button>
      </div>
      <div class="modal-body">
        <div class="muted small">One row per substance across the whole project. Enter a property once here and every stream of that substance, and the Lutze screening, receive it.</div>
        <div id="projectSubstances"></div>
      </div>
    </section>
  </div>

  <div id="hoverTip" class="hover-tip" hidden></div>

  <div id="tutorialOverlay" class="tutorial-overlay" hidden>
    <div id="tutorialSpotlight" class="tutorial-spotlight"></div>
    <div id="tutorialArrow" class="tutorial-arrow" aria-hidden="true" hidden></div>
    <section id="tutorialCard" class="tutorial-card" role="dialog" aria-modal="true" aria-labelledby="tutorialTitle">
      <div class="tutorial-progress" id="tutorialProgress">1 / 7</div>
      <h2 id="tutorialTitle">Tutorial</h2>
      <p id="tutorialBody"></p>
      <div id="tutorialDetail" class="tutorial-detail"></div>
      <div class="tutorial-actions">
        <button id="tutorialPrev" class="mini-button">Back</button>
        <button id="tutorialDo" class="mini-button" hidden>Show</button>
        <button id="tutorialNext" class="primary">Next</button>
        <button id="tutorialSkip" class="mini-button">Close</button>
      </div>
      <button id="tutorialMode" class="tutorial-mode-switch" type="button">Full tour</button>
    </section>
  </div>

  <div id="splitGroupModal" class="modal-backdrop" hidden>
    <section class="modal-panel split-group-panel" role="dialog" aria-modal="true" aria-labelledby="splitGroupTitle">
      <div class="modal-head">
        <div>
          <div class="label">Scale-up bottleneck relief</div>
          <h2 id="splitGroupTitle">Split <span id="splitGroupIdLabel"></span> Into Parallel Units</h2>
        </div>
        <button id="closeSplitGroupModal" class="modal-icon-button" title="Close" aria-label="Close">&times;</button>
      </div>
      <div class="modal-body">
        <div id="splitGroupWarning" class="muted small" hidden></div>
        <label class="split-n-label">
          Split into
          <input type="number" min="2" max="20" step="1" id="splitGroupN" value="2">
          parallel units
        </label>
        <label class="split-mode-row">
          <input type="checkbox" id="splitGroupDivideDuration">
          <span>Divide Gantt duration as a bottleneck-time screening estimate</span>
        </label>
        <div id="splitGroupPreview" class="muted small"></div>
        <div class="row between" style="margin-top:8px">
          <button id="cancelSplitGroup">Cancel</button>
          <button id="confirmSplitGroup" class="primary">Split</button>
        </div>
      </div>
    </section>
  </div>

  <div id="confirmModal" class="modal-backdrop" hidden>
    <section class="modal-panel confirm-panel" role="dialog" aria-modal="true" aria-labelledby="confirmModalTitle">
      <div class="modal-head">
        <div>
          <h2 id="confirmModalTitle">Confirm</h2>
        </div>
      </div>
      <div class="modal-body">
        <div id="confirmModalMessage" class="confirm-modal-message"></div>
        <label id="confirmModalPromptRow" class="confirm-modal-prompt-row" hidden>
          <input type="text" id="confirmModalPromptInput">
        </label>
        <div class="row between" style="margin-top:12px">
          <button id="confirmModalCancel">Cancel</button>
          <button id="confirmModalOk" class="primary">OK</button>
        </div>
      </div>
    </section>
  </div>

  <div id="helpModal" class="modal-backdrop" hidden>
    <section class="modal-panel help-panel" role="dialog" aria-modal="true" aria-labelledby="helpModalTitle">
      <div class="modal-head">
        <div>
          <div class="label">Help</div>
          <h2 id="helpModalTitle">Help</h2>
        </div>
        <button id="closeHelpModal" class="modal-icon-button" title="Close" aria-label="Close">&times;</button>
      </div>
      <div class="modal-body">
        <div id="helpModalBody" class="help-body"></div>
      </div>
    </section>
  </div>

  <div id="flowsheetModal" class="modal-backdrop" hidden>
    <section class="modal-panel flowsheet-panel" role="dialog" aria-modal="true" aria-labelledby="flowsheetTitle">
      <div class="modal-head">
        <div>
          <div class="label">Generated from the current project</div>
          <h2 id="flowsheetTitle">Flowsheet View</h2>
        </div>
        <div class="row flowsheet-toolbar">
          <button class="help-button" data-help-topic="flowsheet" title="Help for the flowsheet" aria-label="Help for the flowsheet">?</button>
          <button id="downloadFlowsheetPptx" class="mini-button primary" title="Download an editable PowerPoint slide made from native shapes, lines, and text boxes">Export PowerPoint</button>
          <div class="header-dropdown flowsheet-options-dropdown">
            <button id="flowsheetOptionsToggle" class="mini-button" aria-haspopup="true" aria-expanded="false" title="Show secondary flowsheet view and export actions">Options ▾</button>
            <div id="flowsheetOptionsMenu" class="header-dropdown-menu flowsheet-options-menu" hidden role="menu">
              <button id="flowsheetEditableMode" class="mini-button primary" role="menuitem" title="Interactive board with draggable units, hover details, and editable labels">Editable Board</button>
              <button id="fitFlowsheetView" class="mini-button primary" role="menuitem" title="Fit the generated flowsheet inside the modal for overview">Fit View</button>
              <button id="downloadFlowsheet" class="mini-button" role="menuitem">Export SVG</button>
            </div>
          </div>
          <div class="workflow-zoom-row flowsheet-zoom-row" title="Zoom the flowsheet drawing">
            <button id="flowsheetZoomOut" title="Zoom out" aria-label="Zoom out">-</button>
            <span id="flowsheetZoomReadout" class="zoom-readout flowsheet-zoom-readout" title="Reset zoom to 100%">100%</span>
            <button id="flowsheetZoomIn" title="Zoom in" aria-label="Zoom in">+</button>
          </div>
          <button id="closeFlowsheetModal" class="flowsheet-close-button" title="Close" aria-label="Close">✕</button>
        </div>
      </div>
      <div class="flowsheet-hint">
        <span>Click a unit for details. Double-click its label to edit it.</span>
        <div class="flowsheet-layer-controls" aria-label="Flowsheet view layers">
          <span>View</span>
          <button id="flowsheetCleanPreset" class="mini-button" title="Clean presentation view: main units and process arrows only">Clean</button>
          <button id="flowsheetDetailedPreset" class="mini-button primary" title="Detailed view: labels, recycle/waste/vent arrows, and unit details">Detailed</button>
          <label class="flowsheet-basis-control" title="Quantities shown: lab batch, scaled batch, or per kg product">
            <span>Basis</span>
            <select id="flowsheetBasisSelect">
              <option value="lab">Lab batch</option>
              <option value="scaled">Scaled batch</option>
              <option value="perKg">Per kg product</option>
            </select>
          </label>
          <label class="flowsheet-table-control" title="Print the stream table (numbers, totals, composition, phases) under the drawing"><input type="checkbox" id="flowsheetStreamTableToggle" checked> Stream table</label>
        </div>
      </div>
      <div class="modal-body">
        <div class="flowsheet-workspace">
          <div id="flowsheetHost" class="flowsheet-host"></div>
          <aside id="flowsheetDetailsPanel" class="flowsheet-details-panel"></aside>
        </div>
      </div>
    </section>
  </div>

  <div id="conversionModal" class="modal-backdrop" hidden>
    <section class="modal-panel conversion-panel" role="dialog" aria-modal="true" aria-labelledby="conversionModalTitle">
      <div class="modal-head">
        <div>
          <div class="label">User-guided reaction definition</div>
          <h2 id="conversionModalTitle">Reaction Balance</h2>
        </div>
        <button class="help-button" data-help-topic="reaction" title="Help for the reaction balance" aria-label="Help for the reaction balance">?</button>
        <button id="closeConversionModal" class="modal-icon-button" title="Close" aria-label="Close">&times;</button>
      </div>
      <div id="conversionModalBody" class="modal-body"></div>
    </section>
  </div>

  <div id="ganttModal" class="modal-backdrop" hidden>
    <section class="modal-panel gantt-modal-panel" role="dialog" aria-modal="true" aria-labelledby="ganttModalTitle">
      <div class="modal-head">
        <div>
          <div class="label">Integrated production schedule</div>
          <h2 id="ganttModalTitle">Schedule &amp; Gantt</h2>
        </div>
        <button class="help-button" data-help-topic="scale" title="Help for the schedule" aria-label="Help for the schedule">?</button>
        <button id="closeGanttModal" class="modal-icon-button" title="Close" aria-label="Close">&times;</button>
      </div>
      <div id="ganttModalBody" class="modal-body"></div>
    </section>
  </div>

  <div id="taskTimetableModal" class="modal-backdrop" hidden>
    <section class="modal-panel task-timetable-modal-panel" role="dialog" aria-modal="true" aria-labelledby="taskTimetableModalTitle">
      <div class="modal-head">
        <div>
          <div class="label">Events inside one task</div>
          <h2 id="taskTimetableModalTitle">Task Timetable</h2>
        </div>
        <button id="closeTaskTimetableModal" class="modal-icon-button" title="Close" aria-label="Close">&times;</button>
      </div>
      <div id="taskTimetableModalBody" class="modal-body"></div>
    </section>
  </div>

  <div id="separationSimulatorModal" class="modal-backdrop" hidden>
    <section class="modal-panel separation-simulator-panel" role="dialog" aria-modal="true" aria-labelledby="separationSimulatorTitle">
      <div class="modal-head">
        <div>
          <div id="separationSimulatorEyebrow" class="label">Optional KB3.1 diagnostic mode</div>
          <h2 id="separationSimulatorTitle">Advanced Separation Sandbox</h2>
        </div>
        <button class="help-button" data-help-topic="lutze" title="Help for the separation screening" aria-label="Help for the separation screening">?</button>
        <button id="closeSeparationSimulator" class="modal-icon-button" title="Close" aria-label="Close">&times;</button>
      </div>
      <div id="separationSimulatorBody" class="modal-body"></div>
    </section>
  </div>

  <div id="processCheckModal" class="modal-backdrop" hidden>
    <section class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="processCheckTitle">
      <div class="modal-head">
        <div>
          <div class="label">Heuristic Rule Application</div>
          <h2 id="processCheckTitle">Heuristic Rule Check</h2>
        </div>
        <button class="help-button" data-help-topic="heuristics" title="Help for the rule check" aria-label="Help for the rule check">?</button>
        <button id="closeProcessCheckModal" class="modal-icon-button" title="Close" aria-label="Close">&times;</button>
      </div>
      <div class="modal-body">
        <div class="modal-columns">
          <div class="modal-column">
            <section class="modal-section modal-controls-card">
              <div>
                <div class="label">Rule Scopes</div>
                <div class="muted small">Select which parts of the built process are checked against the heuristic rules.</div>
              </div>
              <div class="rule-scope-grid">
                <label><input type="checkbox" data-rule-scope="sequence" checked> Sequence & thermal logic</label>
                <label><input type="checkbox" data-rule-scope="mfa" checked> MFA / material closure</label>
                <label><input type="checkbox" data-rule-scope="phases" checked> Phase & unit compatibility</label>
                <label><input type="checkbox" data-rule-scope="conditions" checked> Condition conflicts</label>
                <label><input type="checkbox" data-rule-scope="recycle" checked> Recycle / purge closure</label>
                <label><input type="checkbox" data-rule-scope="scale" checked> Scale-up & bottleneck</label>
              </div>
              <button id="rerunLocalRuleApplication">Apply Selected Checks</button>
            </section>

            <section class="modal-section">
              <div class="label">Process Check Results</div>
              <div class="muted small">Deterministic checks from the current board data.</div>
              <div id="processCheckLocalResult" class="rule-results"></div>
            </section>
          </div>
        </div>
      </div>
    </section>
  </div>

  <script src="/flowsheet.js"></script>
  <script src="/flowsheet_ui.js"></script>
  <script src="/pubchem_core.js"></script>
  <script src="/pubchem.js"></script>
  <script src="/tutorial.js"></script>
  <script src="/lca_bridge.js"></script>
  <script src="/workflow_readiness.js"></script>
  <script src="/export.js"></script>
  <script src="/project_persistence.js"></script>
  <script src="/separation_core.js"></script>
  <script src="/heuristic_rules.js"></script>
  <script src="/help_topics.js"></script>
  <script src="/examples.js"></script>
  <script src="/process_catalogs.js"></script>
  <script src="/app.js"></script>
</body>
</html>
"""

STATIC_ROUTES = {
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "application/javascript; charset=utf-8"),
    "/tutorial.js": ("tutorial.js", "application/javascript; charset=utf-8"),
    "/lca_bridge.js": ("lca_bridge.js", "application/javascript; charset=utf-8"),
    "/workflow_readiness.js": ("workflow_readiness.js", "application/javascript; charset=utf-8"),
    "/export.js": ("export.js", "application/javascript; charset=utf-8"),
    "/project_persistence.js": ("project_persistence.js", "application/javascript; charset=utf-8"),
    "/separation_core.js": ("separation_core.js", "application/javascript; charset=utf-8"),
    "/heuristic_rules.js": ("heuristic_rules.js", "application/javascript; charset=utf-8"),
    "/help_topics.js": ("help_topics.js", "application/javascript; charset=utf-8"),
    "/examples.js": ("examples.js", "application/javascript; charset=utf-8"),
    "/process_catalogs.js": ("process_catalogs.js", "application/javascript; charset=utf-8"),
    "/pubchem_core.js": ("pubchem_core.js", "application/javascript; charset=utf-8"),
    "/flowsheet.js": ("flowsheet.js", "application/javascript; charset=utf-8"),
    "/flowsheet_ui.js": ("flowsheet_ui.js", "application/javascript; charset=utf-8"),
    "/flowsheet.css": ("flowsheet.css", "text/css; charset=utf-8"),
    "/pubchem.js": ("pubchem.js", "application/javascript; charset=utf-8"),
    "/favicon.svg": ("favicon.svg", "image/svg+xml"),
}


class AppHandler(BaseHTTPRequestHandler):
    # A client that opens a connection and never finishes its request used to hold a thread for
    # as long as it liked; the server is one thread per connection.
    timeout = 30
    server_version = "ProcessUpscalingWorkbench"
    sys_version = ""

    def _send_no_cache_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        for name, value in SECURITY_HEADERS:
            self.send_header(name, value)

    def _client_key(self):
        # Behind Render's proxy the socket peer is the proxy; the first forwarded address is the
        # client. Locally there is no proxy and the peer is the client.
        forwarded = self.headers.get("X-Forwarded-For", "")
        first = forwarded.split(",")[0].strip() if forwarded else ""
        return first or self.client_address[0]

    def _resolve(self):
        """The body to send, its content type, and a key that changes when the file changes."""
        if self.path in ("/", "/index.html"):
            return APP_HTML.encode("utf-8"), "text/html; charset=utf-8", ("index.html", len(APP_HTML))
        if self.path in STATIC_ROUTES:
            filename, content_type = STATIC_ROUTES[self.path]
            try:
                stat = os.stat(os.path.join(STATIC_DIR, filename))
                cache_key = (filename, stat.st_mtime_ns, stat.st_size)
            except OSError:
                cache_key = None
            return _read_static(filename).encode("utf-8"), content_type, cache_key
        return None, None, None

    def _prepare_static_response(self):
        body, content_type, cache_key = self._resolve()
        if body is None:
            return None, None, None
        encoding = None
        if cache_key is not None and len(body) >= GZIP_MIN_BYTES and _accepts_gzip(self.headers):
            body = _gzip_body(cache_key, body)
            encoding = "gzip"
        return body, content_type, encoding

    def _send_static_headers(self, body, content_type, encoding):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Vary", "Accept-Encoding")
        if encoding:
            self.send_header("Content-Encoding", encoding)
        self._send_no_cache_headers()
        self.end_headers()

    def do_HEAD(self):
        body, content_type, encoding = self._prepare_static_response()
        if body is None:
            self.send_error(404)
            return
        self._send_static_headers(body, content_type, encoding)

    def do_GET(self):
        body, content_type, encoding = self._prepare_static_response()
        if body is None:
            self.send_error(404)
            return
        self._send_static_headers(body, content_type, encoding)
        self.wfile.write(body)

    def do_POST(self):
        if self.path not in ("/api/flowsheet-pptx", "/api/lci-xlsx", "/api/pubchem"):
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError:
            self._send_json(400, {"ok": False, "error": "Invalid Content-Length header."})
            return
        limit = PUBCHEM_MAX_REQUEST_BYTES if self.path == "/api/pubchem" else MAX_REQUEST_BYTES
        if length <= 0 or length > limit:
            self._send_json(413, {"ok": False, "error": f"Request body must be between 1 and {limit} bytes."})
            return
        if self.path == "/api/pubchem" and not _pubchem_allowed(self._client_key()):
            self._send_json(429, {"ok": False, "error": "Too many PubChem lookups; wait a minute and try again."})
            return
        try:
            try:
                payload = _decode_json_payload(self.rfile.read(length))
            except ValueError as exc:
                self._send_json(400, {"ok": False, "error": str(exc)})
                return
            if self.path == "/api/pubchem":
                result = self._lookup_pubchem(payload)
            elif self.path == "/api/flowsheet-pptx":
                try:
                    body = _export_renderer("pptx")(payload)
                except RuntimeError as exc:
                    self._send_json(503, {"ok": False, "error": str(exc)})
                    return
                except ValueError as exc:
                    self._send_json(400, {"ok": False, "error": str(exc)})
                    return
                self._send_binary(
                    200,
                    body,
                    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                    "flowsheet.pptx",
                )
                return
            elif self.path == "/api/lci-xlsx":
                try:
                    body = _export_renderer("xlsx")(payload.get("project", payload))
                except RuntimeError as exc:
                    self._send_json(503, {"ok": False, "error": str(exc)})
                    return
                self._send_binary(
                    200,
                    body,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    "lci-workbook.xlsx",
                )
                return
            self._send_json(200, result)
        except Exception:
            # The traceback goes to the server log; the client gets no library internals or paths.
            traceback.print_exc()
            self._send_json(500, {"ok": False, "error": "The server could not process this request."})

    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._send_no_cache_headers()
        self.end_headers()
        self.wfile.write(body)

    def _send_binary(self, status, body, content_type, filename):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("Content-Length", str(len(body)))
        self._send_no_cache_headers()
        self.end_headers()
        self.wfile.write(body)

    def _lookup_pubchem(self, payload):
        cache_key = (str(payload.get("mode", "lookup")).strip().lower(), str(payload.get("name", "")).strip().lower())
        return _pubchem_cached(cache_key, lambda: lookup_pubchem(payload))

    def log_message(self, format, *args):
        print("%s - %s" % (self.address_string(), format % args))


def main():
    parser = argparse.ArgumentParser(description="Run the Process Upscaling Workbench.")
    parser.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8787")))
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), AppHandler)
    print(f"Process Upscaling Workbench running at http://{args.host}:{args.port}")
    print("Press Ctrl+C to stop.")
    server.serve_forever()


if __name__ == "__main__":
    main()
