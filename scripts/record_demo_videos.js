#!/usr/bin/env node
"use strict";

// Records one short, narrated screen video per section of the tool (cursor, captions, zoom).
//   node scripts/record_demo_videos.js [scene-prefix ...] [--out=DIR]
// With no scene prefix every scene is recorded. Needs Playwright + Chromium (see check_browser_smoke.js).
//
// Most scenes run on the built-in biodiesel example (a complete, coherent project) rather than the
// guided tutorial's half-built state, so every panel has real content to show. Only the
// text-to-task scene uses the tutorial helpers, because that is the one interaction worth acting out.

const { main } = require("./demo_video/lib");

const loadBiodiesel = async (d, options = {}) => {
  await d.eval(opts => { loadBiodieselExampleProject(opts); tutorialRevealPanels(); renderAll(); }, options);
  await d.wait(1200);
};

const scenes = [
  {
    name: "00_sections_tour",
    run: async (d) => {
      await loadBiodiesel(d);
      await d.title("Process Upscaling Workbench", "The interface in 30 seconds", "Lab protocol in, industrial flowsheet out");
      await d.zoom({ x: 0, y: 55, w: 760, h: 60 }, { max: 2.4 });
      await d.say("**Workflow bar**: six steps, each ticked when its evidence is complete", { hold: 2600 });
      await d.zoom("#protocolPanel", { max: 2.2, maxH: 560 });
      await d.say("**Protocol**: the lab text, with each passage that became a block", { hold: 2600 });
      await d.zoom(".workflow-panel", { max: 1.4 });
      await d.say("**Process map**: tasks, unit operations, material links and recycles", { hold: 2800 });
      await d.zoom("#inspectorPanel", { max: 1.7, maxH: 600 });
      await d.say("**Inspector**: phenomena of the selected task…", { hold: 1800 });
      await d.click("[data-inspector-tab=\"heuristics\"]", { after: 300 });
      await d.zoom("#inspectorPanel", { max: 1.7, maxH: 600 });
      await d.say("…heuristic rule checks…", { hold: 1800 });
      await d.click("[data-inspector-tab=\"scale\"]", { after: 300 });
      await d.zoom("#inspectorPanel", { max: 1.7, maxH: 600 });
      await d.say("…and scale-up: target, capacity, reactor size", { hold: 2200 });
      await d.unzoom();
      await d.click("#openFlowsheet", { after: 1600 });
      await d.say("**Flowsheet View**: the process as an editable PFD, exportable to PowerPoint", { hold: 3000 });
      await d.mute();
    }
  },
  {
    name: "01_text_to_task",
    run: async (d) => {
      await d.eval(() => tutorialResetProject());
      await d.wait(600);
      await d.title("Part 1", "From text to task", "One sentence becomes one process block");
      await d.zoom("#protocolPanel", { max: 1.8, maxH: 700 });
      await d.say("Paste the protocol and **load** it", { step: 1, hold: 1800 });
      await d.click("#loadTextSide", { after: 400 });
      await d.eval(() => tutorialLoadTextView());
      await d.zoom("#annotatedText", { max: 1.8 });
      await d.say("Select the sentence of **one physical operation**", { step: 2, hold: 1200 });
      await d.eval(() => tutorialHighlightText());
      await d.wait(1400);
      await d.zoom("#createBlockSide", { max: 2.6 });
      await d.say("**Create Block**", { step: 3, hold: 1200 });
      await d.click("#createBlockSide", { after: 1100 });
      await d.unzoom();
      await d.zoom("[data-block-card]", { max: 2.4 });
      await d.say("Behaviour, conditions and phenomena are guessed: **a draft to check**", { step: 4, hold: 2800 });
      await d.zoom("#phenomenaGridSection", { max: 1.9, maxH: 520 });
      await d.say("Fix the **phenomena** in the inspector", { step: 5, hold: 2200 });
      await d.unzoom();
      await d.zoom("[data-assign-task]", { max: 3 });
      await d.say("**Convert To Task**", { step: 6, hold: 1200 });
      await d.click("[data-assign-task]", { after: 900 });
      await d.confirmOk();
      await d.zoom("#groupFlow", { max: 2 });
      await d.say("The task is in the process graph: ready for materials, units and scale-up", { hold: 2800 });
      await d.mute();
      await d.unzoom();
    }
  },
  {
    name: "02_process_map",
    run: async (d) => {
      await loadBiodiesel(d);
      await d.title("Process map", "Tasks, units and links", "Biodiesel example: 8 tasks, 11 arrows");
      await d.zoom("#groupFlow", { max: 1.4 });
      await d.say("Each box is a **task** with its unit operation; dashed arrows are **recycles**", { hold: 3000 });
      await d.eval(() => selectGroup("G2"));
      await d.wait(700);
      await d.zoom(".group-box.active", { max: 2.6 });
      await d.say("Select a task: **G2**, the transesterification reactor", { hold: 2200 });
      await d.unzoom();
      await d.zoom(".group-mfa-grid", { max: 1.5, maxH: 640 });
      await d.say("The editor below lists its **inputs and outlets** with amounts, phases and roles", { hold: 3000 });
      await d.unzoom();
      // Expanded board: the compact boxes are too small to read the unit picker.
      await d.eval(() => { state.boardCompact = false; ensureGroup("G2").unitSuggestionsExpanded = false; selectGroup("G2"); state.zoom = 1.1; renderAll(); setTimeout(() => centerSelection(), 120); });
      await d.wait(900);
      await d.zoom(".group-box.active", { max: 2.4, maxH: 420 });
      await d.say("Expanded, the task shows its phenomena, conditions and the chosen **unit operation**", { hold: 2800 });
      await d.click("[data-suggest-unit-operation=\"G2\"]", { after: 600 });
      await d.unzoom();
      // Shrink the material editor so the board viewport is tall enough to show the whole picker.
      await d.eval(() => { setStepEditorHeight(120); renderAll(); centerSelection(); setTimeout(() => { document.querySelector(".board-unit-picker")?.scrollIntoView({ block: "center", inline: "center" }); window.scrollTo(0, 0); }, 150); });
      await d.wait(700);
      await d.pointAt("#groupFlow", { dx: 0.03, dy: 0.95 });
      await d.zoom(".board-unit-picker", { max: 3.2 });
      await d.say("**Switch Unit Operation**: ranked alternatives, each stating **why** it matched", { hold: 3000 });
      await d.mute();
      await d.unzoom();
    }
  },
  {
    name: "03_reaction_balance",
    run: async (d) => {
      await loadBiodiesel(d);
      await d.eval(() => { const b = state.blocks.find(x => x.groupId === "G2"); selectBlock(b.id, false); openConversionModal(b.id); });
      await d.wait(1200);
      await d.title("Reaction balance", "Yield, conversion, residuals", "The reaction sentence as a reviewed mass balance");
      await d.zoom(".conversion-basis-section", { max: 1.8, maxH: 640 });
      await d.say("**Reference amount, yield, conversion, selectivity** of the limiting reagent", { hold: 3000 });
      await d.unzoom();
      await d.zoom("#conversionModalBody", { max: 1.4, maxH: 820 });
      await d.say("The stoichiometric equation and the computed product and **residual reactants**", { hold: 3000 });
      await d.eval(() => { state.conversionView = "outputs"; renderConversionModal(); });
      await d.wait(900);
      await d.say("Outputs view: what leaves the reactor, by component", { hold: 2400 });
      await d.zoom("#conversionApplyBalance", { max: 3 });
      await d.say("**Save reaction balance** writes it to the material inventory", { hold: 2200 });
      await d.mute();
      await d.unzoom();
    }
  },
  {
    name: "04_separation_lutze",
    run: async (d) => {
      await loadBiodiesel(d, { reactionOnly: true });
      await d.eval(() => selectGroup("G2"));
      await d.wait(800);
      await d.title("Separation", "Lutze/Garg pathway screening", "Build the separation train after the reactor");
      // The launch button sits low in the material editor: scroll it into the editor's viewport first.
      await d.eval(() => { document.querySelector("[data-open-lutze-reaction-separation]")?.scrollIntoView({ block: "center" }); window.scrollTo(0, 0); });
      await d.wait(400);
      await d.zoom("[data-open-lutze-reaction-separation]", { max: 2.4 });
      await d.say("From the reaction task, open the **Lutze/Garg screening**", { hold: 1800 });
      await d.click("[data-open-lutze-reaction-separation]", { after: 1500 });
      if (await d.eval(() => document.getElementById("separationSimulatorModal").hidden)) {
        await d.eval(() => openLutzeReactionSeparation("G2"));
        await d.wait(1200);
      }
      await d.unzoom();
      await d.zoom("#separationSimulatorBody .pathway-context, #separationSimulatorBody", { max: 1.7, maxH: 500 });
      await d.say("**Objective**: the product to retain and where each component should go", { hold: 2800 });
      await d.unzoom();
      await d.zoom(".pathway-alternative-grid", { max: 1.5, maxH: 760 });
      await d.say("Complete **candidate routes**, screened in the background and compared side by side", { hold: 3200 });
      await d.click(".pathway-alternative-grid [data-pathway-use-alternative]", { after: 1400 });
      await d.unzoom();
      await d.zoom(".pathway-canvas", { max: 1.6, maxH: 760 });
      await d.say("The chosen route as an **editable draft**: every step shows what leaves and what remains", { hold: 3200 });
      await d.unzoom();
      await d.zoom("[data-pathway-apply]", { max: 2.6 });
      await d.say("**Apply pathway** sends it back to the process map as tasks", { hold: 1800 });
      await d.click("[data-pathway-apply]", { after: 1500 });
      await d.unzoom();
      await d.zoom("#groupFlow", { max: 1.4 });
      await d.say("The separation train is now part of the network", { hold: 2600 });
      await d.mute();
      await d.unzoom();
    }
  },
  {
    name: "05_heuristics",
    run: async (d) => {
      await loadBiodiesel(d);
      await d.eval(() => { setInspectorTab("heuristics"); runRuleChecks?.(); });
      await d.wait(900);
      await d.title("Heuristics", "Rule checks", "Is the process evidence coherent?");
      await d.zoom("#heuristicsPanel", { max: 1.7, maxH: 560 });
      await d.say("Rules are **triggered** from phenomena, phases, conditions and the source text", { hold: 3000 });
      await d.zoom("#heuristicRuleCheckPanel .rule-card", { max: 2.4 });
      await d.say("Each **finding** names the rule, the tasks it applies to, and a decision to take", { hold: 3200 });
      await d.mute();
      await d.unzoom();
    }
  },
  {
    name: "06_scaleup_schedule",
    run: async (d) => {
      await loadBiodiesel(d);
      await d.eval(() => { setInspectorTab("scale"); renderAll(); });
      await d.wait(900);
      await d.title("Scale-up", "Target, capacity, schedule", "4000 t/year of methyl oleate");
      await d.zoom("#scaleQuickPanel", { max: 2.3, maxH: 300 });
      await d.say("Set the **target product** and the production basis", { hold: 2400 });
      await d.unzoom();
      await d.zoom("#scaleBasisPanel", { max: 1.6, maxH: 640 });
      await d.say("**Conservative vs overlapped** plan: batches per year, reactor volume, bottleneck", { hold: 3400 });
      await d.unzoom();
      await d.click("[data-open-gantt]", { after: 1500 });
      await d.zoom("#ganttModalBody", { max: 1.5, maxH: 720 });
      await d.say("**Schedule & Gantt**: critical path, cycle time and the task that limits it", { hold: 3400 });
      await d.mute();
      await d.eval(() => closeGanttModal?.());
      await d.unzoom();
    }
  },
  {
    name: "07_flowsheet",
    run: async (d) => {
      await loadBiodiesel(d);
      await d.title("Result", "Flowsheet View", "An editable PFD with stream table");
      await d.click("#openFlowsheet", { after: 1800 });
      await d.say("Units, numbered streams, a mass balance per unit and the **stream table**", { hold: 3000 });
      await d.zoom("#flowsheetModal svg", { max: 1.6, maxH: 520 });
      await d.say("Main train in black; recycle, waste and vent loops on separate lines", { hold: 3000 });
      await d.unzoom();
      await d.click("#flowsheetCleanPreset", { after: 1200 });
      await d.say("**Clean** view for presentations: main units and process arrows only", { hold: 2600 });
      await d.zoom("#downloadFlowsheetPptx", { max: 3 });
      await d.say("**Export PowerPoint** reproduces the drawing as editable shapes", { hold: 2600 });
      await d.mute();
      await d.unzoom();
    }
  }
];

main(scenes).catch(error => { console.error(error); process.exit(1); });
