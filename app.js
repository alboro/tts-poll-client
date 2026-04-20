(function () {
  "use strict";

  const STORAGE_CONFIG = "ttsPollClient.config.v1";
  const STORAGE_JOBS = "ttsPollClient.jobs.v1";

  const DEFAULT_CONFIG = {
    baseUrl: "http://127.0.0.1:8030",
    textInput: "Привет. Это тестовый запрос через HTML polling client.",
    voiceInput: "reference_long",
    responseFormatInput: "wav",
    createMethod: "POST",
    createPath: "/v1/tts/jobs",
    headersJson: JSON.stringify({ "Content-Type": "application/json" }, null, 2),
    bodyTemplate: JSON.stringify(
      {
        input: "{{text}}",
        voice: "{{voice}}",
        response_format: "{{response_format}}"
      },
      null,
      2
    ),
    pollMethod: "GET",
    statusPathTemplate: "/v1/tts/jobs/{id}",
    audioMethod: "GET",
    audioPathTemplate: "/v1/tts/jobs/{id}/audio",
    pollIntervalMs: 5000,
    initialDelayMs: 1000,
    maxAttempts: 0,
    requestTimeoutMs: 60000,
    idPath: "id",
    statusPath: "status",
    audioReadyPath: "audio_ready",
    statusUrlPath: "status_url",
    audioUrlPath: "audio_url",
    successValues: "completed,done,succeeded,success",
    failureValues: "failed,error,canceled,cancelled"
  };

  const FIELD_IDS = Object.keys(DEFAULT_CONFIG);
  const TERMINAL_STATES = new Set(["completed", "failed", "stopped"]);
  const state = {
    config: loadConfig(),
    jobs: loadJobs()
  };

  const els = {};

  document.addEventListener("DOMContentLoaded", () => {
    bindElements();
    applyConfigToForm(state.config);
    bindEvents();
    restoreJobs();
    renderJobs();
    setStatus("Ready");
  });

  function bindElements() {
    for (const id of FIELD_IDS) {
      els[id] = document.getElementById(id);
    }
    els.form = document.getElementById("submitForm");
    els.statusLine = document.getElementById("statusLine");
    els.healthButton = document.getElementById("healthButton");
    els.saveConfigButton = document.getElementById("saveConfigButton");
    els.resetConfigButton = document.getElementById("resetConfigButton");
    els.clearJobsButton = document.getElementById("clearJobsButton");
    els.pauseAllButton = document.getElementById("pauseAllButton");
    els.resumeAllButton = document.getElementById("resumeAllButton");
    els.jobList = document.getElementById("jobList");
    els.jobTemplate = document.getElementById("jobTemplate");
  }

  function bindEvents() {
    els.form.addEventListener("submit", handleSubmit);
    els.healthButton.addEventListener("click", runHealthCheck);
    els.saveConfigButton.addEventListener("click", () => {
      saveConfigFromForm();
      setStatus("Config saved");
    });
    els.resetConfigButton.addEventListener("click", () => {
      state.config = { ...DEFAULT_CONFIG };
      applyConfigToForm(state.config);
      persistConfig();
      setStatus("Config reset");
    });
    els.clearJobsButton.addEventListener("click", clearDoneJobs);
    els.pauseAllButton.addEventListener("click", pauseAllJobs);
    els.resumeAllButton.addEventListener("click", resumeAllJobs);

    for (const id of FIELD_IDS) {
      els[id].addEventListener("change", saveConfigFromForm);
      els[id].addEventListener("input", debounce(saveConfigFromForm, 250));
    }

    document.querySelectorAll("[data-preset]").forEach((button) => {
      button.addEventListener("click", () => applyPreset(button.dataset.preset));
    });

    els.jobList.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) {
        return;
      }
      const card = button.closest("[data-client-id]");
      const job = state.jobs.find((item) => item.clientId === card.dataset.clientId);
      if (!job) {
        return;
      }
      handleJobAction(job, button.dataset.action);
    });
  }

  async function handleSubmit(event) {
    event.preventDefault();
    const config = readConfigFromForm();
    state.config = config;
    persistConfig();

    const job = createLocalJob(config);
    state.jobs.unshift(job);
    addLog(job, "Queued create request");
    persistJobs();
    renderJobs();

    try {
      job.state = "creating";
      renderJobs();
      const createUrl = joinUrl(config.baseUrl, config.createPath);
      const headers = parseJsonObject(config.headersJson, "Headers JSON");
      const body = renderBodyTemplate(config.bodyTemplate, {
        text: config.textInput,
        voice: config.voiceInput,
        response_format: config.responseFormatInput
      });

      const createStarted = performance.now();
      const envelope = await proxyRequest({
        url: createUrl,
        method: config.createMethod,
        headers,
        body,
        responseType: "json",
        timeoutMs: config.requestTimeoutMs
      });
      addLog(job, `Create response in ${formatMs(performance.now() - createStarted)}`);
      assertTargetOk(envelope, "Create request failed");

      const responseJson = requireJson(envelope, "Create response");
      const id = getByPath(responseJson, config.idPath);
      if (id === undefined || id === null || String(id).trim() === "") {
        throw new Error(`Create response did not contain id at path "${config.idPath}"`);
      }

      job.id = String(id);
      job.status = readTextValue(responseJson, config.statusPath) || "queued";
      job.statusUrl = resolveResponseUrl(
        responseJson,
        config.statusUrlPath,
        config.baseUrl,
        config.statusPathTemplate,
        job.id
      );
      job.audioUrl = resolveResponseUrl(
        responseJson,
        config.audioUrlPath,
        config.baseUrl,
        config.audioPathTemplate,
        job.id
      );
      job.state = "polling";
      job.lastResponse = responseJson;
      addLog(job, `Created remote job ${job.id}`);
      schedulePoll(job, Number(config.initialDelayMs) || 0);
    } catch (error) {
      job.state = "failed";
      job.error = error.message;
      addLog(job, error.message);
    } finally {
      persistJobs();
      renderJobs();
    }
  }

  async function runHealthCheck() {
    const config = readConfigFromForm();
    try {
      const envelope = await proxyRequest({
        url: joinUrl(config.baseUrl, "/health"),
        method: "GET",
        headers: {},
        body: null,
        responseType: "json",
        timeoutMs: config.requestTimeoutMs
      });
      if (envelope.ok) {
        setStatus(`Health OK: ${config.baseUrl}`);
      } else {
        setStatus(`Health HTTP ${envelope.status}`);
      }
    } catch (error) {
      setStatus(error.message);
    }
  }

  async function pollJob(job) {
    if (job.state !== "polling") {
      return;
    }
    const config = job.config;
    const maxAttempts = Number(config.maxAttempts) || 0;
    if (maxAttempts > 0 && job.attempts >= maxAttempts) {
      job.state = "failed";
      job.error = `Max attempts reached: ${maxAttempts}`;
      addLog(job, job.error);
      persistJobs();
      renderJobs();
      return;
    }

    job.attempts += 1;
    addLog(job, `Poll ${job.attempts}`);
    persistJobs();
    renderJobs();

    try {
      const pollStarted = performance.now();
      const envelope = await proxyRequest({
        url: job.statusUrl,
        method: config.pollMethod,
        headers: parseJsonObject(config.headersJson, "Headers JSON"),
        body: null,
        responseType: "json",
        timeoutMs: config.requestTimeoutMs
      });
      addLog(job, `Poll response in ${formatMs(performance.now() - pollStarted)}`);
      assertTargetOk(envelope, "Status request failed");
      const responseJson = requireJson(envelope, "Status response");
      applyStatusResponse(job, responseJson);

      if (isFailureStatus(job.status, config)) {
        job.state = "failed";
        job.error = readTextValue(responseJson, "error") || `Remote status: ${job.status}`;
        addLog(job, job.error);
      } else if (job.audioReady || isSuccessStatus(job.status, config)) {
        await fetchAudio(job);
      } else {
        schedulePoll(job, Number(config.pollIntervalMs) || 5000);
      }
    } catch (error) {
      job.lastError = error.message;
      addLog(job, error.message);
      schedulePoll(job, Number(config.pollIntervalMs) || 5000);
    } finally {
      persistJobs();
      renderJobs();
    }
  }

  function applyStatusResponse(job, responseJson) {
    const config = job.config;
    const statusValue = readTextValue(responseJson, config.statusPath);
    if (statusValue) {
      job.status = statusValue;
    }
    const audioReadyValue = getByPath(responseJson, config.audioReadyPath);
    job.audioReady = normalizeBoolean(audioReadyValue);
    const statusUrl = resolveResponseUrl(
      responseJson,
      config.statusUrlPath,
      config.baseUrl,
      config.statusPathTemplate,
      job.id
    );
    const audioUrl = resolveResponseUrl(
      responseJson,
      config.audioUrlPath,
      config.baseUrl,
      config.audioPathTemplate,
      job.id
    );
    if (statusUrl) {
      job.statusUrl = statusUrl;
    }
    if (audioUrl) {
      job.audioUrl = audioUrl;
    }
    job.lastResponse = responseJson;
  }

  async function fetchAudio(job) {
    if (!job.audioUrl) {
      throw new Error("Audio URL is missing");
    }
    job.state = "fetching_audio";
    addLog(job, "Fetching audio");
    renderJobs();

    const audioStarted = performance.now();
    const envelope = await proxyRequest({
      url: job.audioUrl,
      method: job.config.audioMethod,
      headers: parseJsonObject(job.config.headersJson, "Headers JSON"),
      body: null,
      responseType: "blob",
      timeoutMs: job.config.requestTimeoutMs
    });
    addLog(job, `Audio response in ${formatMs(performance.now() - audioStarted)}`);
    assertTargetOk(envelope, "Audio request failed");
    if (!envelope.bodyBase64) {
      throw new Error("Audio response did not include a body");
    }

    if (job.audioObjectUrl) {
      URL.revokeObjectURL(job.audioObjectUrl);
    }
    const contentType = envelope.contentType || "audio/wav";
    const blob = base64ToBlob(envelope.bodyBase64, contentType);
    job.audioObjectUrl = URL.createObjectURL(blob);
    job.audioContentType = contentType;
    job.state = "completed";
    job.status = job.status || "completed";
    job.audioReady = true;
    addLog(job, `Audio ready (${blob.size} bytes)`);
  }

  function schedulePoll(job, delayMs) {
    clearJobTimer(job);
    if (TERMINAL_STATES.has(job.state)) {
      return;
    }
    job.state = "polling";
    job.timer = window.setTimeout(() => pollJob(job), Math.max(delayMs, 0));
  }

  function clearJobTimer(job) {
    if (job.timer) {
      window.clearTimeout(job.timer);
      job.timer = null;
    }
  }

  function handleJobAction(job, action) {
    if (action === "pause") {
      clearJobTimer(job);
      if (!TERMINAL_STATES.has(job.state)) {
        job.state = "paused";
        addLog(job, "Paused");
      }
    } else if (action === "resume") {
      if (job.id && job.state !== "completed") {
        addLog(job, "Resumed");
        schedulePoll(job, 0);
      }
    } else if (action === "stop") {
      clearJobTimer(job);
      job.state = "stopped";
      addLog(job, "Stopped");
    } else if (action === "delete") {
      clearJobTimer(job);
      if (job.audioObjectUrl) {
        URL.revokeObjectURL(job.audioObjectUrl);
      }
      state.jobs = state.jobs.filter((item) => item.clientId !== job.clientId);
    } else if (action === "refetch") {
      if (job.audioUrl) {
        fetchAudio(job).catch((error) => {
          job.state = "failed";
          job.error = error.message;
          addLog(job, error.message);
          persistJobs();
          renderJobs();
        });
      }
    }
    persistJobs();
    renderJobs();
  }

  function pauseAllJobs() {
    for (const job of state.jobs) {
      if (!TERMINAL_STATES.has(job.state)) {
        clearJobTimer(job);
        job.state = "paused";
        addLog(job, "Paused");
      }
    }
    persistJobs();
    renderJobs();
  }

  function resumeAllJobs() {
    for (const job of state.jobs) {
      if (job.id && !TERMINAL_STATES.has(job.state)) {
        addLog(job, "Resumed");
        schedulePoll(job, 0);
      }
    }
    persistJobs();
    renderJobs();
  }

  function clearDoneJobs() {
    for (const job of state.jobs) {
      if (TERMINAL_STATES.has(job.state)) {
        clearJobTimer(job);
        if (job.audioObjectUrl) {
          URL.revokeObjectURL(job.audioObjectUrl);
        }
      }
    }
    state.jobs = state.jobs.filter((job) => !TERMINAL_STATES.has(job.state));
    persistJobs();
    renderJobs();
  }

  function renderJobs() {
    els.jobList.textContent = "";
    if (!state.jobs.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No jobs";
      els.jobList.appendChild(empty);
      return;
    }

    for (const job of state.jobs) {
      const fragment = els.jobTemplate.content.cloneNode(true);
      const card = fragment.querySelector(".job-card");
      card.dataset.clientId = job.clientId;
      fragment.querySelector(".job-title").textContent = job.id ? `Job ${job.id}` : "Local job";
      fragment.querySelector(".job-subtitle").textContent = `${job.config.baseUrl} | ${job.voice || "voice"} | ${job.createdAt}`;
      const statePill = fragment.querySelector(".job-state");
      statePill.textContent = job.state;
      statePill.className = `job-state ${job.state}`;
      fragment.querySelector(".job-meta").textContent = buildJobMeta(job);
      fragment.querySelector(".job-log").textContent = (job.logs || []).join("\n");
      renderAudioSlot(fragment.querySelector(".audio-slot"), job);
      updateJobButtons(fragment, job);
      els.jobList.appendChild(fragment);
    }
  }

  function buildJobMeta(job) {
    const parts = [
      `status=${job.status || "n/a"}`,
      `attempts=${job.attempts || 0}`,
      `audio_ready=${job.audioReady ? "true" : "false"}`
    ];
    if (job.error) {
      parts.push(`error=${job.error}`);
    } else if (job.lastError) {
      parts.push(`last_error=${job.lastError}`);
    }
    return parts.join(" | ");
  }

  function renderAudioSlot(slot, job) {
    slot.textContent = "";
    if (job.audioObjectUrl) {
      const audio = document.createElement("audio");
      audio.controls = true;
      audio.src = job.audioObjectUrl;
      const link = document.createElement("a");
      link.href = job.audioObjectUrl;
      link.download = `${job.id || job.clientId}.wav`;
      link.textContent = "Download audio";
      slot.append(audio, link);
    } else if (job.state === "completed" && job.audioUrl) {
      const text = document.createElement("span");
      text.className = "job-meta";
      text.textContent = "Audio can be fetched again.";
      slot.appendChild(text);
    }
  }

  function updateJobButtons(fragment, job) {
    const buttons = {};
    fragment.querySelectorAll("button[data-action]").forEach((button) => {
      buttons[button.dataset.action] = button;
    });
    buttons.pause.disabled = TERMINAL_STATES.has(job.state) || job.state === "paused";
    buttons.resume.disabled = !job.id || job.state === "completed" || job.state === "polling" || job.state === "creating" || job.state === "fetching_audio";
    buttons.stop.disabled = TERMINAL_STATES.has(job.state);
    buttons.refetch.disabled = !job.audioUrl || job.state === "fetching_audio";
  }

  function restoreJobs() {
    for (const job of state.jobs) {
      job.timer = null;
      job.audioObjectUrl = null;
      if (job.id && !TERMINAL_STATES.has(job.state) && job.state !== "paused") {
        addLog(job, "Restored polling after page load");
        schedulePoll(job, 500);
      }
    }
    persistJobs();
  }

  function createLocalJob(config) {
    return {
      clientId: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      createdAt: new Date().toLocaleString(),
      config: { ...config },
      textPreview: config.textInput.slice(0, 160),
      voice: config.voiceInput,
      id: null,
      status: "local",
      audioReady: false,
      statusUrl: null,
      audioUrl: null,
      attempts: 0,
      state: "queued",
      logs: [],
      error: null,
      lastError: null,
      lastResponse: null,
      timer: null,
      audioObjectUrl: null,
      audioContentType: null
    };
  }

  function addLog(job, message) {
    const timestamp = new Date().toLocaleTimeString();
    job.logs = job.logs || [];
    job.logs.push(`[${timestamp}] ${message}`);
    if (job.logs.length > 80) {
      job.logs = job.logs.slice(job.logs.length - 80);
    }
  }

  async function proxyRequest(payload) {
    const response = await fetch("/api/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const envelope = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error((envelope && envelope.error) || `Proxy HTTP ${response.status}`);
    }
    return envelope;
  }

  function assertTargetOk(envelope, prefix) {
    if (!envelope || envelope.ok) {
      return;
    }
    const details = envelope.bodyText || envelope.statusText || "";
    throw new Error(`${prefix}: HTTP ${envelope.status} ${details}`.trim());
  }

  function requireJson(envelope, label) {
    if (envelope.bodyJson !== undefined) {
      return envelope.bodyJson;
    }
    throw new Error(`${label} was not JSON`);
  }

  function renderBodyTemplate(template, variables) {
    let rendered = String(template || "");
    for (const [key, value] of Object.entries(variables)) {
      const quotedPlaceholder = `"{{${key}}}"`;
      rendered = rendered.split(quotedPlaceholder).join(JSON.stringify(value));
    }
    for (const [key, value] of Object.entries(variables)) {
      const placeholder = `{{${key}}}`;
      rendered = rendered.split(placeholder).join(JSON.stringify(value));
    }
    return parseJsonObject(rendered, "Body JSON Template");
  }

  function parseJsonObject(value, label) {
    const text = String(value || "").trim();
    if (!text) {
      return {};
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`${label}: ${error.message}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${label} must be a JSON object`);
    }
    return parsed;
  }

  function getByPath(source, path) {
    const normalized = String(path || "").trim().replace(/^\$\.?/, "");
    if (!normalized) {
      return undefined;
    }
    const parts = normalized.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
    let current = source;
    for (const part of parts) {
      if (current === null || current === undefined) {
        return undefined;
      }
      current = current[part];
    }
    return current;
  }

  function readTextValue(source, path) {
    const value = getByPath(source, path);
    if (value === undefined || value === null) {
      return "";
    }
    return String(value);
  }

  function normalizeBoolean(value) {
    if (value === true) {
      return true;
    }
    if (typeof value === "string") {
      return ["true", "1", "yes", "ready"].includes(value.toLowerCase());
    }
    return Boolean(value);
  }

  function resolveResponseUrl(responseJson, path, baseUrl, fallbackTemplate, id) {
    const value = readTextValue(responseJson, path);
    if (value) {
      return joinUrl(baseUrl, value);
    }
    if (!fallbackTemplate || !id) {
      return "";
    }
    return joinUrl(baseUrl, String(fallbackTemplate).replaceAll("{id}", encodeURIComponent(id)));
  }

  function joinUrl(baseUrl, path) {
    const value = String(path || "").trim();
    if (/^https?:\/\//i.test(value)) {
      return value;
    }
    const base = String(baseUrl || "").trim().replace(/\/+$/, "");
    if (!base) {
      throw new Error("Server URL is required");
    }
    if (!value) {
      return base;
    }
    return `${base}/${value.replace(/^\/+/, "")}`;
  }

  function isSuccessStatus(status, config) {
    return valueInList(status, config.successValues);
  }

  function isFailureStatus(status, config) {
    return valueInList(status, config.failureValues);
  }

  function valueInList(value, listText) {
    if (!value) {
      return false;
    }
    const normalized = String(value).toLowerCase();
    return String(listText || "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
      .includes(normalized);
  }

  function base64ToBlob(base64, contentType) {
    const binary = atob(base64);
    const chunks = [];
    for (let offset = 0; offset < binary.length; offset += 8192) {
      const slice = binary.slice(offset, offset + 8192);
      const bytes = new Uint8Array(slice.length);
      for (let index = 0; index < slice.length; index += 1) {
        bytes[index] = slice.charCodeAt(index);
      }
      chunks.push(bytes);
    }
    return new Blob(chunks, { type: contentType || "application/octet-stream" });
  }

  function applyPreset(name) {
    const config = readConfigFromForm();
    if (name === "qwen") {
      config.baseUrl = "http://127.0.0.1:8030";
      config.voiceInput = "reference_long";
    } else if (name === "xtts") {
      config.baseUrl = "http://127.0.0.1:8020";
      config.voiceInput = "reference_long";
    }
    state.config = config;
    applyConfigToForm(config);
    persistConfig();
    setStatus(`Preset applied: ${name}`);
  }

  function readConfigFromForm() {
    const config = {};
    for (const id of FIELD_IDS) {
      const element = els[id];
      if (element.type === "number") {
        config[id] = Number(element.value);
      } else {
        config[id] = element.value;
      }
    }
    return config;
  }

  function saveConfigFromForm() {
    state.config = readConfigFromForm();
    persistConfig();
  }

  function applyConfigToForm(config) {
    for (const id of FIELD_IDS) {
      if (!els[id]) {
        continue;
      }
      els[id].value = config[id] ?? DEFAULT_CONFIG[id] ?? "";
    }
  }

  function loadConfig() {
    const saved = readStorage(STORAGE_CONFIG);
    return { ...DEFAULT_CONFIG, ...(saved || {}) };
  }

  function loadJobs() {
    const saved = readStorage(STORAGE_JOBS);
    if (!Array.isArray(saved)) {
      return [];
    }
    return saved.map((job) => ({
      ...job,
      timer: null,
      audioObjectUrl: null
    }));
  }

  function persistConfig() {
    localStorage.setItem(STORAGE_CONFIG, JSON.stringify(state.config));
  }

  function persistJobs() {
    const serializable = state.jobs.map((job) => {
      const clone = { ...job };
      delete clone.timer;
      delete clone.audioObjectUrl;
      return clone;
    });
    localStorage.setItem(STORAGE_JOBS, JSON.stringify(serializable));
  }

  function readStorage(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (_error) {
      return null;
    }
  }

  function setStatus(message) {
    els.statusLine.textContent = message;
  }

  function formatMs(value) {
    if (value < 1000) {
      return `${Math.round(value)} ms`;
    }
    return `${(value / 1000).toFixed(1)} s`;
  }

  function debounce(fn, waitMs) {
    let timer = null;
    return function debounced() {
      window.clearTimeout(timer);
      timer = window.setTimeout(fn, waitMs);
    };
  }
})();
