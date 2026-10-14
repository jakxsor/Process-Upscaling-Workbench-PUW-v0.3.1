    // Save / Restore / Import / Autosave for the whole project. This is what the header's "Work ▾"
    // menu (Save Snapshot, Restore Autosave, Import JSON) and the automatic autosave-on-edit are
    // built from — look here first for anything about where project data goes when you're not
    // actively exporting a file. Loaded as a plain <script> after export.js and before app.js (see
    // app.py), so these functions share the same global scope as the rest of the app.
    // Depends on: buildProjectExport, cloneProjectValue (both in export.js); $, state, pushUndo,
    // confirmModal, alertModal, renderAll, escapeHtml, escapeAttr (in app.js).
    // renderExport() (in export.js, called throughout app.js after every edit) is what schedules the
    // debounced autosave defined here via scheduleProjectAutosave().

    const projectAutosaveKey = "upscalingWorkbench.autosave.v1";
    const projectSnapshotsKey = "upscalingWorkbench.snapshots.v1";
    const currentProjectSchemaVersion = "upscaling-project-v1";
    const currentStateSchemaVersion = "workbench-state-v1";
    let projectAutosaveTimer = null;
    let projectPersistencePaused = false;
    let projectAutosaveContainsUserWork = false;

    function markProjectAutosaveAsExampleOnly() {
      projectAutosaveContainsUserWork = false;
    }

    function markProjectAutosaveAsUserWork() {
      projectAutosaveContainsUserWork = true;
    }

    function projectHasAutosaveWorthyUserWork() {
      return projectAutosaveContainsUserWork;
    }

    function projectWorkTitle(project) {
      const basisName = String(project?.scaleUp?.basis?.targetProduct || project?.projectState?.scaleBasis?.targetProduct || "").trim();
      if (basisName) return basisName;
      const text = String(project?.text || project?.projectState?.text || "").trim().replace(/\s+/g, " ");
      return text ? text.slice(0, 48) : "Untitled project";
    }

    function projectHasWork(project) {
      const snapshot = project?.projectState || project;
      return Boolean(String(snapshot?.text || "").trim() || (Array.isArray(snapshot?.blocks) && snapshot.blocks.length));
    }

    function readProjectAutosave() {
      try {
        return JSON.parse(localStorage.getItem(projectAutosaveKey) || "null");
      } catch (err) {
        return null;
      }
    }

    function readProjectSnapshots() {
      try {
        const parsed = JSON.parse(localStorage.getItem(projectSnapshotsKey) || "[]");
        return Array.isArray(parsed) ? parsed : [];
      } catch (err) {
        return [];
      }
    }

    function writeProjectSnapshots(items) {
      localStorage.setItem(projectSnapshotsKey, JSON.stringify(items.slice(0, 12)));
    }

    function writeProjectAutosaveNow() {
      if (projectPersistencePaused) return;
      if (!projectAutosaveContainsUserWork) {
        renderSavedWorkMenu();
        return;
      }
      try {
        const project = buildProjectExport();
        localStorage.setItem(projectAutosaveKey, JSON.stringify({
          savedAt: new Date().toISOString(),
          title: projectWorkTitle(project),
          restoreOnBoot: true,
          project
        }));
        renderSavedWorkMenu();
      } catch (err) {
        const status = $("savedWorkStatus");
        if (status) status.textContent = `Autosave unavailable: ${err.message || err}`;
      }
    }

    function scheduleProjectAutosave() {
      if (projectPersistencePaused) return;
      if (projectAutosaveTimer) clearTimeout(projectAutosaveTimer);
      projectAutosaveTimer = setTimeout(() => {
        projectAutosaveTimer = null;
        // The write serialises the whole project; do it when the browser is idle rather than in
        // the middle of the next keystroke.
        if (typeof requestIdleCallback === "function") requestIdleCallback(() => writeProjectAutosaveNow(), { timeout: 2000 });
        else writeProjectAutosaveNow();
      }, 900);
    }

    function saveLocalProjectSnapshot(title = "") {
      const project = buildProjectExport();
      if (!projectHasWork(project)) return false;
      const snapshots = readProjectSnapshots();
      snapshots.unshift({
        id: `snapshot-${Date.now()}`,
        title: String(title || "").trim() || projectWorkTitle(project),
        savedAt: new Date().toISOString(),
        restoreOnBoot: true,
        project
      });
      try {
        writeProjectSnapshots(snapshots);
        localStorage.setItem(projectAutosaveKey, JSON.stringify(snapshots[0]));
      } catch (err) {
        alertModal(`Could not save project in this browser: ${err.message || err}`);
        return false;
      }
      renderSavedWorkMenu();
      return true;
    }

    function propertyListToState(properties) {
      if (!Array.isArray(properties)) return properties && typeof properties === "object" ? properties : {};
      return Object.fromEntries(properties
        .filter(item => item && typeof item === "object" && item.id)
        .map(item => [item.id, {
          value: item.value || "",
          unit: item.unit || "",
          status: item.status || "",
          note: item.note || ""
        }]));
    }

    function isPlainProjectObject(value) {
      return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    function isScalarProjectValue(value) {
      return value === null || ["string", "number", "boolean"].includes(typeof value);
    }

    function requireProjectObject(value, path) {
      if (!isPlainProjectObject(value)) throw new Error(`${path} must be an object.`);
      return value;
    }

    function requireProjectArray(value, path) {
      if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
      return value;
    }

    // Block ids and group keys are written into element attributes and option lists by the

    // renderer; an id that is markup is not an id. The app itself only ever mints B1/G1-style ids.

    const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

    function requireProjectId(value, path) {

      if (!PROJECT_ID_PATTERN.test(String(value ?? ""))) {

        throw new Error(`${path} must be a short identifier (letters, digits, _ . -).`);

      }

    }


    function validateOptionalProjectObject(value, path) {
      if (value !== undefined && !isPlainProjectObject(value)) throw new Error(`${path} must be an object.`);
    }

    function validateOptionalProjectArray(value, path) {
      if (value !== undefined && !Array.isArray(value)) throw new Error(`${path} must be an array.`);
    }

    function validateOptionalProjectScalar(value, path) {
      if (value !== undefined && !isScalarProjectValue(value)) throw new Error(`${path} must be a scalar value.`);
    }

    function validateProjectStateSnapshot(snapshot) {
      requireProjectObject(snapshot, "projectState");
      if (snapshot.schemaVersion && ![currentStateSchemaVersion, `${currentStateSchemaVersion}-reconstructed`].includes(snapshot.schemaVersion)) {
        throw new Error(`Unsupported workbench state schema: ${snapshot.schemaVersion}. Expected ${currentStateSchemaVersion}.`);
      }

      const groups = requireProjectObject(snapshot.groups, "projectState.groups");
      const blocks = requireProjectArray(snapshot.blocks, "projectState.blocks");
      validateOptionalProjectArray(snapshot.links, "projectState.links");
      validateOptionalProjectObject(snapshot.scaleBasis, "projectState.scaleBasis");
      validateOptionalProjectObject(snapshot.heuristicDecisions, "projectState.heuristicDecisions");
      validateOptionalProjectArray(snapshot.ruleChecks, "projectState.ruleChecks");
      validateOptionalProjectObject(snapshot.processRuleOptions, "projectState.processRuleOptions");
      validateOptionalProjectObject(snapshot.board, "projectState.board");
      validateOptionalProjectObject(snapshot.flowsheet, "projectState.flowsheet");

      Object.entries(groups).forEach(([groupId, group]) => {
        requireProjectId(groupId, `projectState.groups key "${groupId}"`);
        requireProjectObject(group, `projectState.groups.${groupId}`);
        if (group.id !== undefined && String(group.id).trim() !== String(groupId)) {
          throw new Error(`projectState.groups.${groupId}.id must match its group key.`);
        }
        validateOptionalProjectObject(group.schedule, `projectState.groups.${groupId}.schedule`);
        validateOptionalProjectObject(group.properties, `projectState.groups.${groupId}.properties`);
        validateOptionalProjectObject(group.propertyPredictor, `projectState.groups.${groupId}.propertyPredictor`);
        validateOptionalProjectObject(group.timeOffsets, `projectState.groups.${groupId}.timeOffsets`);
        validateOptionalProjectScalar(group.task, `projectState.groups.${groupId}.task`);
        validateOptionalProjectScalar(group.selectedUnit, `projectState.groups.${groupId}.selectedUnit`);
        validateOptionalProjectScalar(group.selectionBasis, `projectState.groups.${groupId}.selectionBasis`);
      });

      blocks.forEach((block, blockIndex) => {
        const path = `projectState.blocks[${blockIndex}]`;
        requireProjectObject(block, path);
        if (!String(block.id || "").trim()) throw new Error(`${path}.id must be a non-empty string.`);
        requireProjectId(block.id, `${path}.id`);
        if (block.groupId !== undefined) {
          validateOptionalProjectScalar(block.groupId, `${path}.groupId`);
          if (String(block.groupId || "").trim() && !groups[String(block.groupId)]) {
            throw new Error(`${path}.groupId must reference an existing projectState.groups entry.`);
          }
        }
        if (block.start !== undefined && !Number.isFinite(Number(block.start))) throw new Error(`${path}.start must be a finite number.`);
        if (block.end !== undefined && !Number.isFinite(Number(block.end))) throw new Error(`${path}.end must be a finite number.`);
        if (block.start !== undefined && block.end !== undefined && Number(block.end) < Number(block.start)) {
          throw new Error(`${path}.end must be greater than or equal to start.`);
        }
        requireProjectArray(block.streams, `${path}.streams`);
        validateOptionalProjectArray(block.phenomena, `${path}.phenomena`);
        block.streams.forEach((stream, streamIndex) => {
          const streamPath = `${path}.streams[${streamIndex}]`;
          requireProjectObject(stream, streamPath);
          validateOptionalProjectScalar(stream.role, `${streamPath}.role`);
          validateOptionalProjectScalar(stream.name, `${streamPath}.name`);
          validateOptionalProjectScalar(stream.quantity, `${streamPath}.quantity`);
          validateOptionalProjectScalar(stream.unit, `${streamPath}.unit`);
          validateOptionalProjectScalar(stream.status, `${streamPath}.status`);
          validateOptionalProjectScalar(stream.destinationGroup, `${streamPath}.destinationGroup`);
          if (String(stream.destinationGroup || "").trim() && !groups[String(stream.destinationGroup)]) {
            throw new Error(`${streamPath}.destinationGroup must reference an existing projectState.groups entry.`);
          }
        });
      });

      (snapshot.links || []).forEach((link, linkIndex) => {
        const path = `projectState.links[${linkIndex}]`;
        requireProjectObject(link, path);
        if (!String(link.from || "").trim()) throw new Error(`${path}.from must be a non-empty string.`);
        if (!String(link.to || "").trim()) throw new Error(`${path}.to must be a non-empty string.`);
      });
    }

    function validateProjectImport(project) {
      if (!project || typeof project !== "object" || Array.isArray(project)) {
        throw new Error("The selected JSON is not a project object.");
      }
      if (project.exportSchemaVersion && project.exportSchemaVersion !== currentProjectSchemaVersion) {
        throw new Error(`Unsupported project schema: ${project.exportSchemaVersion}. Expected ${currentProjectSchemaVersion}.`);
      }
      const snapshot = project.projectState;
      if (snapshot !== undefined) {
        validateProjectStateSnapshot(snapshot);
      } else if (!Array.isArray(project.blocks) || !Array.isArray(project.groups)) {
        throw new Error("Legacy project JSON must contain blocks and groups arrays.");
      }
      return project;
    }

    function migrateProjectStateSnapshot(snapshot) {
      const migrated = cloneProjectValue(snapshot, {});
      migrated.schemaVersion = currentStateSchemaVersion;
      migrated.blocks = (migrated.blocks || []).map(block => ({
        ...block,
        source: block?.source || "protocol"
      }));
      return migrated;
    }

    function projectStateFromExport(project) {
      validateProjectImport(project);
      if (project?.projectState && typeof project.projectState === "object") return migrateProjectStateSnapshot(project.projectState);
      const groups = {};
      const exportedGroups = Array.isArray(project?.groups) ? project.groups : [];
      exportedGroups.forEach((group, index) => {
        const id = String(group.groupId || group.id || `G${index + 1}`);
        groups[id] = {
          id,
          task: group.task || "unassigned",
          selectedUnit: group.selectedUnit || "",
          selectionBasis: group.selectionBasis || "",
          schedule: group.schedule || {},
          properties: propertyListToState(group.properties),
          propertyPredictor: group.propertyPredictor || { mode: "skip", expanded: false },
          separationSimulator: group.separationSimulator || null,
          x: 520 + (index % 4) * 560,
          y: 90 + Math.floor(index / 4) * 330
        };
      });
      return migrateProjectStateSnapshot({
        schemaVersion: "workbench-state-v1-reconstructed",
        text: project?.text || "",
        blocks: Array.isArray(project?.blocks) ? project.blocks : [],
        groups,
        links: Array.isArray(project?.links) ? project.links : [],
        scaleBasis: project?.scaleUp?.basis || {},
        heuristicDecisions: project?.heuristicDecisions || {},
        ruleChecks: project?.ruleChecks || [],
        processCheck: project?.processCheck || null,
        processRuleOptions: {},
        board: { boardCompact: false, draftPos: { x: 24, y: 24 }, zoom: 0.78 },
        flowsheet: { viewPreset: "detailed", selectedGroupId: "", fit: true, showAuxiliaryArrows: true, showUnitDetails: false, showStreamLabels: true }
      });
    }

    function applyProjectStateSnapshot(snapshot, options = {}) {
      const groupsAreValid = snapshot?.groups && typeof snapshot.groups === "object" && !Array.isArray(snapshot.groups)
        && Object.values(snapshot.groups).every(group => group && typeof group === "object" && !Array.isArray(group));
      const blocksAreValid = Array.isArray(snapshot?.blocks)
        && snapshot.blocks.every(block => block && typeof block === "object" && !Array.isArray(block) && String(block.id || "").trim());
      const linksAreValid = snapshot?.links === undefined || (Array.isArray(snapshot.links)
        && snapshot.links.every(link => link && typeof link === "object" && !Array.isArray(link)));
      if (!snapshot || !blocksAreValid || !groupsAreValid || !linksAreValid) {
        throw new Error("This JSON does not contain a reloadable project state.");
      }
      if (options.pushUndo !== false) pushUndo();
      projectPersistencePaused = true;
      try {
        state.text = String(snapshot.text || "");
        state.blocks = cloneProjectValue(snapshot.blocks, []);
        state.groups = cloneProjectValue(snapshot.groups, {});
        state.links = cloneProjectValue(snapshot.links, []);
        state.scaleBasis = cloneProjectValue(snapshot.scaleBasis, {});
        state.heuristicDecisions = cloneProjectValue(snapshot.heuristicDecisions, {});
        state.ruleChecks = cloneProjectValue(snapshot.ruleChecks, []);
        state.processCheck = cloneProjectValue(snapshot.processCheck, null);
        state.processRuleOptions = { ...state.processRuleOptions, ...(snapshot.processRuleOptions || {}) };
        state.boardCompact = Boolean(snapshot.board?.boardCompact);
        state.draftPos = cloneProjectValue(snapshot.board?.draftPos, { x: 24, y: 24 });
        state.zoom = Number.isFinite(snapshot.board?.zoom) ? snapshot.board.zoom : 0.78;
        state.flowsheetViewPreset = snapshot.flowsheet?.viewPreset === "clean" ? "clean" : "detailed";
        state.selectedFlowsheetGroupId = snapshot.flowsheet?.selectedGroupId || "";
        state.flowsheetFit = snapshot.flowsheet?.fit !== false;
        state.flowsheetShowAuxiliaryArrows = snapshot.flowsheet?.showAuxiliaryArrows !== false;
        state.flowsheetShowUnitDetails = snapshot.flowsheet?.showUnitDetails === true;
        state.flowsheetShowStreamLabels = snapshot.flowsheet?.showStreamLabels !== false;
        state.selectedBlockId = null;
        state.selectedGroupId = null;
        state.selectedIds = [];
        state.menuBlockId = null;
        state.menuGroupId = null;
        state.menuStreamId = null;
        state.connectingFrom = null;
        state.connectDrag = null;
        state.focusEndpoint = null;
        const source = $("sourceInput");
        if (source) source.value = state.text;
      } finally {
        projectPersistencePaused = false;
      }
      markProjectAutosaveAsUserWork();
      renderAll();
      writeProjectAutosaveNow();
    }

    async function applyImportedProject(project, options = {}) {
      validateProjectImport(project);
      if (options.confirmReplace !== false && projectHasWork(buildProjectExport())) {
        const ok = await confirmModal("Load this saved project? It replaces the current workspace. The current state is kept in Undo and autosave.");
        if (!ok) return false;
      }
      applyProjectStateSnapshot(projectStateFromExport(project), { pushUndo: options.pushUndo !== false });
      return true;
    }

    async function importProjectJsonFile(event) {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        const project = JSON.parse(await file.text());
        await applyImportedProject(project);
      } catch (err) {
        await alertModal(`Could not import project JSON: ${err.message || err}`);
      } finally {
        event.target.value = "";
      }
    }

    async function restoreAutosavedProject() {
      const entry = readProjectAutosave();
      if (!entry?.project) {
        await alertModal("No autosaved project was found in this browser.");
        return false;
      }
      return applyImportedProject(entry.project, { confirmReplace: true });
    }

    async function maybeRestoreAutosavedProject() {
      const entry = readProjectAutosave();
      if (!entry?.project || entry.restoreOnBoot !== true || !projectHasWork(entry.project)) return false;
      const savedAt = entry.savedAt ? new Date(entry.savedAt).toLocaleString() : "unknown time";
      const ok = await confirmModal(`Restore autosaved work "${entry.title || "Untitled project"}" from ${savedAt}? Choose Cancel to load the example project instead.`);
      if (!ok) return false;
      applyProjectStateSnapshot(projectStateFromExport(entry.project), { pushUndo: false });
      return true;
    }

    function renderSavedWorkMenu() {
      const status = $("savedWorkStatus");
      const list = $("savedProjectList");
      if (!status || !list) return;
      const autosave = readProjectAutosave();
      const snapshots = readProjectSnapshots();
      status.textContent = autosave?.savedAt
        ? `Autosaved ${new Date(autosave.savedAt).toLocaleString()}.`
        : "No autosave yet.";
      const restoreButton = $("restoreAutosaveProject");
      if (restoreButton) restoreButton.disabled = !autosave?.project;
      list.innerHTML = snapshots.length
        ? snapshots.map(item => `
          <div class="saved-project-row">
            <button type="button" data-restore-snapshot="${escapeAttr(item.id)}" title="Restore this saved snapshot">
              <strong>${escapeHtml(item.title || "Untitled project")}</strong>
              <span>${escapeHtml(item.savedAt ? new Date(item.savedAt).toLocaleString() : "")}</span>
            </button>
            <button type="button" class="saved-project-delete" data-delete-snapshot="${escapeAttr(item.id)}" title="Delete this local snapshot">Delete</button>
          </div>
        `).join("")
        : `<div class="muted small">No manual snapshots yet.</div>`;
    }

    async function handleSavedProjectListClick(event) {
      const restore = event.target.closest("[data-restore-snapshot]");
      if (restore) {
        const entry = readProjectSnapshots().find(item => item.id === restore.dataset.restoreSnapshot);
        if (entry?.project) await applyImportedProject(entry.project, { confirmReplace: true });
        return;
      }
      const del = event.target.closest("[data-delete-snapshot]");
      if (del) {
        const entry = readProjectSnapshots().find(item => item.id === del.dataset.deleteSnapshot);
        if (!entry) return;
        const ok = await confirmModal(`Delete local snapshot "${entry.title || "Untitled project"}"?`);
        if (!ok) return;
        writeProjectSnapshots(readProjectSnapshots().filter(item => item.id !== del.dataset.deleteSnapshot));
        renderSavedWorkMenu();
      }
    }
