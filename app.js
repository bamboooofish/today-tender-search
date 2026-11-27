'use strict';

(() => {
  // Set this to the deployed Apps Script Web App URL ending in /exec.
  const APPS_SCRIPT_URL =
    'https://script.google.com/macros/s/AKfycbz7lV7tuMMZNmATiEnY5RCfD3Tl6z0ePGUWmkNZTSQhqvoYSlk2EzM1hFaFJ6crPaHV/exec';
  const MAX_SELECTIONS = 5;
  const GROUP_STORAGE_KEY = 'tender_filter_groups_v2';
  const ALLOWED_ANNOUNCEMENT_TYPES = new Set([
    '公開招標公告',
    '經公開評選或公開徵求之限制性招標公告',
    '選擇性招標(建立合格廠商名單)公告',
    '選擇性招標(個案)公告',
    '選擇性招標後續邀標公告',
    '公開取得報價單或企劃書公告',
    '公開招標更正公告',
    '經公開評選或公開徵求之限制性招標更正公告',
    '選擇性招標(建立合格廠商名單)更正公告',
    '選擇性招標(個案)更正公告',
    '選擇性招標後續邀標更正公告',
    '公開取得報價單或企劃書更正公告',
  ]);
  const FILTER_STORAGE = {
    titleInclude: 'tender_title_includes',
    agencyInclude: 'tender_agency_includes',
    titleExclude: 'tender_title_excludes',
    agencyExclude: 'tender_agency_excludes',
  };
  const state = {
    date: '',
    dateTo: '',
    dateMode: 'today',
    dateLoadVersion: 0,
    dateLoading: false,
    archivePromise: null,
    archiveItems: [],
    items: [],
    groups: [],
    activeGroupId: '',
    appliedGroups: [],
    activeResultId: 'all',
    selected: new Map(),
    detailTexts: [],
    detailsLoading: false,
    loadError: '',
  };
  let draggedGroupId = '';
  const byId = (id) => document.getElementById(id);

  function todayInTaipei() {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Taipei',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const values = {};
    parts.forEach((part) => {
      values[part.type] = part.value;
    });
    return values.year + '-' + values.month + '-' + values.day;
  }

  function shiftDate(value, days) {
    const date = new Date(value + 'T00:00:00Z');
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }

  function normalizeDate(value, fallback) {
    const text = normalize(value);
    const match = text.match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
    if (!match) return fallback || '';
    const iso = match[1] + '-' + match[2] + '-' + match[3];
    const parsed = new Date(iso + 'T00:00:00Z');
    return Number.isNaN(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== iso
      ? fallback || ''
      : iso;
  }

  function newFilterGroup(name) {
    return {
      id:
        'group-' +
        Date.now().toString(36) +
        '-' +
        Math.random().toString(36).slice(2, 7),
      name: name || '查詢組合',
      enabled: true,
      titleInclude: '',
      agencyInclude: '',
      titleExclude: '',
      agencyExclude: '',
      includeJoin: 'AND',
      excludeJoin: 'AND',
    };
  }

  function copyGroup(group) {
    return {
      id: String(group.id || newFilterGroup().id),
      name: String(group.name || '查詢組合'),
      enabled: Boolean(group.enabled),
      titleInclude: String(group.titleInclude || ''),
      agencyInclude: String(group.agencyInclude || ''),
      titleExclude: String(group.titleExclude || ''),
      agencyExclude: String(group.agencyExclude || ''),
      includeJoin: group.includeJoin === 'OR' ? 'OR' : 'AND',
      excludeJoin: group.excludeJoin === 'OR' ? 'OR' : 'AND',
    };
  }

  function normalize(value) {
    return String(value == null ? '' : value)
      .normalize('NFKC')
      .trim();
  }

  function splitTerms(value) {
    return normalize(value)
      .split(/[,\uFF0C\u3001;\uFF1B\n\r]+/)
      .map((term) => term.trim().toLocaleLowerCase())
      .filter(Boolean);
  }

  function itemKey(item) {
    return [
      item.date,
      item.agency,
      item.id,
      item.title,
      item.type,
      item.unit_id,
      item.filename,
    ]
      .map(normalize)
      .join('|');
  }

  function validOfficialUrl(url) {
    if (!url) return '';
    try {
      const parsed = new URL(url, 'https://web.pcc.gov.tw');
      if (parsed.protocol === 'https:' && parsed.hostname === 'web.pcc.gov.tw')
        return parsed.href;
    } catch (_) {}
    return '';
  }

  function officialUrl(item) {
    const existingUrl = validOfficialUrl(item.url);
    if (existingUrl) return existingUrl;
    return (
      'https://web.pcc.gov.tw/prkms/tender/common/basic/readTenderBasic?tenderId=' +
      encodeURIComponent(item.id || '') +
      '&dateType=isNow'
    );
  }

  function saveGroups() {
    try {
      localStorage.setItem(GROUP_STORAGE_KEY, JSON.stringify(state.groups));
    } catch (_) {}
  }

  function loadGroups() {
    let hasSavedGroups = false;
    try {
      const saved = JSON.parse(
        localStorage.getItem(GROUP_STORAGE_KEY) || 'null',
      );
      if (Array.isArray(saved)) {
        state.groups = saved.map(copyGroup);
        hasSavedGroups = true;
      }
    } catch (_) {}

    if (!hasSavedGroups) {
      const group = newFilterGroup('查詢組合 1');
      Object.entries(FILTER_STORAGE).forEach(([field, key]) => {
        try {
          group[field] = localStorage.getItem(key) || '';
          localStorage.removeItem(key);
        } catch (_) {}
      });
      state.groups = [group];
      saveGroups();
    }
    state.activeGroupId = state.groups[0] ? state.groups[0].id : '';
  }

  function downloadFilterGroups() {
    const payload = {
      format: 'tender-filter-groups',
      version: 1,
      groups: state.groups.map(copyGroup),
    };
    const file = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = '查詢組合-' + todayInTaipei() + '.json';
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function parseImportedFilterGroups(payload) {
    if (
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      payload.format !== 'tender-filter-groups' ||
      payload.version !== 1 ||
      !Array.isArray(payload.groups)
    ) {
      throw new Error('檔案格式不正確，請選擇查詢組合 JSON 檔。');
    }
    if (!payload.groups.length) {
      throw new Error('檔案中沒有查詢組合。');
    }
    const textFields = [
      'titleInclude',
      'agencyInclude',
      'titleExclude',
      'agencyExclude',
    ];
    const groupsAreValid = payload.groups.every(
      (group) =>
        group &&
        typeof group === 'object' &&
        !Array.isArray(group) &&
        typeof group.name === 'string' &&
        group.name.trim() &&
        typeof group.enabled === 'boolean' &&
        textFields.every((field) => typeof group[field] === 'string') &&
        ['AND', 'OR'].includes(group.includeJoin) &&
        ['AND', 'OR'].includes(group.excludeJoin),
    );
    if (!groupsAreValid) {
      throw new Error('查詢組合資料不完整或格式不正確。');
    }

    return payload.groups.map((group) => {
      const imported = copyGroup(group);
      imported.id = newFilterGroup().id;
      return imported;
    });
  }

  async function importFilterGroups(event) {
    const input = event.currentTarget;
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;

    let payload;
    try {
      payload = JSON.parse(await file.text());
    } catch (_) {
      window.alert('匯入失敗：檔案不是有效的 JSON。');
      return;
    }

    let groups;
    try {
      groups = parseImportedFilterGroups(payload);
    } catch (error) {
      window.alert('匯入失敗：' + error.message);
      return;
    }

    if (state.detailsLoading) {
      window.alert('明細載入中，請稍後再匯入。');
      return;
    }
    if (!window.confirm('匯入會取代目前所有查詢組合，確定要繼續嗎？')) {
      return;
    }

    state.groups = groups;
    state.activeGroupId = groups[0].id;
    saveGroups();
    renderGroupTabs();
    renderGroupEditor();
    applyFilters();
  }

  function deleteFilterGroup(groupId) {
    const removedIndex = state.groups.findIndex(
      (group) => group.id === groupId,
    );
    if (removedIndex < 0) return;
    state.groups = state.groups.filter((group) => group.id !== groupId);
    if (state.activeGroupId === groupId) {
      state.activeGroupId = state.groups.length
        ? state.groups[Math.min(removedIndex, state.groups.length - 1)].id
        : '';
    }
    saveGroups();
    renderGroupTabs();
    renderGroupEditor();
    applyFilters();
  }

  function renderGroupTabs() {
    const tabs = byId('filterGroupTabs');
    tabs.replaceChildren();
    const clearDropMarkers = () => {
      tabs.querySelectorAll('.drop-before, .drop-after').forEach((item) => {
        item.classList.remove('drop-before', 'drop-after');
      });
    };
    state.groups.forEach((group, index) => {
      const tabItem = document.createElement('div');
      tabItem.className =
        'group-tab-item' +
        (group.id === state.activeGroupId ? ' is-active' : '');
      tabItem.draggable = state.groups.length > 1;
      tabItem.addEventListener('dragstart', (event) => {
        if (event.target.closest('.remove-group-button')) {
          event.preventDefault();
          return;
        }
        draggedGroupId = group.id;
        tabItem.classList.add('is-dragging');
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', group.id);
      });
      tabItem.addEventListener('dragover', (event) => {
        if (!draggedGroupId || draggedGroupId === group.id) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        clearDropMarkers();
        const after =
          event.clientX >
          tabItem.getBoundingClientRect().left +
            tabItem.getBoundingClientRect().width / 2;
        tabItem.classList.add(after ? 'drop-after' : 'drop-before');
      });
      tabItem.addEventListener('dragleave', (event) => {
        if (!tabItem.contains(event.relatedTarget)) {
          tabItem.classList.remove('drop-before', 'drop-after');
        }
      });
      tabItem.addEventListener('drop', (event) => {
        if (!draggedGroupId) return;
        event.preventDefault();
        const sourceIndex = state.groups.findIndex(
          (entry) => entry.id === draggedGroupId,
        );
        const targetIndex = state.groups.findIndex(
          (entry) => entry.id === group.id,
        );
        if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
          return;
        }
        const rect = tabItem.getBoundingClientRect();
        let insertIndex =
          targetIndex + (event.clientX > rect.left + rect.width / 2 ? 1 : 0);
        const [movedGroup] = state.groups.splice(sourceIndex, 1);
        if (sourceIndex < insertIndex) insertIndex -= 1;
        state.groups.splice(insertIndex, 0, movedGroup);
        draggedGroupId = '';
        saveGroups();
        state.appliedGroups = state.groups.map(copyGroup);
        renderGroupTabs();
        render();
      });
      tabItem.addEventListener('dragend', () => {
        draggedGroupId = '';
        clearDropMarkers();
        tabItem.classList.remove('is-dragging');
      });
      const button = document.createElement('button');
      button.type = 'button';
      button.className =
        'group-tab' + (group.id === state.activeGroupId ? ' is-active' : '');
      button.setAttribute('role', 'tab');
      button.setAttribute(
        'aria-selected',
        String(group.id === state.activeGroupId),
      );
      button.textContent = group.name || '查詢組合 ' + (index + 1);
      button.addEventListener('click', () => {
        state.activeGroupId = group.id;
        renderGroupTabs();
        renderGroupEditor();
      });
      tabItem.append(button);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.draggable = false;
      remove.className = 'remove-group-button';
      const removeIcon = document.createElement('span');
      removeIcon.className = 'remove-group-icon';
      removeIcon.setAttribute('aria-hidden', 'true');
      removeIcon.textContent = '×';
      remove.append(removeIcon);
      remove.setAttribute(
        'aria-label',
        '刪除組合 ' + (group.name || index + 1),
      );
      remove.addEventListener('click', (event) => {
        event.stopPropagation();
        deleteFilterGroup(group.id);
      });
      tabItem.append(remove);
      tabs.append(tabItem);
    });
  }

  function renderJoinControl(group, key) {
    const control = document.createElement('div');
    control.className = 'join-control';
    ['AND', 'OR'].forEach((operator) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className =
        'join-choice' + (group[key] === operator ? ' is-active' : '');
      button.textContent = operator;
      button.setAttribute('aria-pressed', String(group[key] === operator));
      button.addEventListener('click', () => {
        group[key] = operator;
        saveGroups();
        renderGroupEditor();
        applyFilters();
      });
      control.append(button);
    });
    return control;
  }

  function renderCriteriaSection(group, heading, suffix, joinKey) {
    const section = document.createElement('section');
    section.className = 'filter-group';
    const title = document.createElement('h4');
    title.className = 'filter-group-label';
    title.textContent = heading;
    const fields = document.createElement('div');
    fields.className = 'field-grid with-join';
    const names = ['title' + suffix, 'agency' + suffix];
    names.forEach((name) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'field';
      const textarea = document.createElement('textarea');
      textarea.rows = 3;
      textarea.placeholder = name.startsWith('title') ? '標案名稱' : '機關名稱';
      textarea.setAttribute(
        'aria-label',
        heading + '：' + textarea.placeholder,
      );
      textarea.value = group[name];
      textarea.addEventListener('input', () => {
        group[name] = textarea.value;
        saveGroups();
      });
      wrapper.append(textarea);
      fields.append(wrapper);
      if (name === names[0]) fields.append(renderJoinControl(group, joinKey));
    });
    section.append(title, fields);
    return section;
  }

  function renderGroupEditor() {
    const host = byId('filterGroupEditor');
    host.replaceChildren();
    const group = state.groups.find(
      (entry) => entry.id === state.activeGroupId,
    );
    if (!group) return;

    const editor = document.createElement('div');
    editor.className = 'group-editor';
    const heading = document.createElement('div');
    heading.className = 'group-name-row';
    const nameInput = document.createElement('input');
    nameInput.id = 'activeGroupName';
    nameInput.className = 'group-name-input';
    nameInput.type = 'text';
    nameInput.maxLength = 40;
    nameInput.placeholder = '組合名稱';
    nameInput.value = group.name;
    nameInput.setAttribute('aria-label', '組合名稱');
    nameInput.addEventListener('input', () => {
      group.name = nameInput.value;
      saveGroups();
      renderGroupTabs();
    });
    const enabledLabel = document.createElement('label');
    enabledLabel.className = 'group-enabled';
    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.checked = group.enabled;
    enabled.addEventListener('change', () => {
      group.enabled = enabled.checked;
      saveGroups();
      applyFilters();
    });
    enabledLabel.append(enabled, document.createTextNode('啟用'));
    heading.append(enabledLabel);

    editor.append(
      heading,
      nameInput,
      renderCriteriaSection(group, '包含條件', 'Include', 'includeJoin'),
      renderCriteriaSection(group, '排除條件', 'Exclude', 'excludeJoin'),
    );
    host.append(editor);
  }

  function groupMatchesField(text, rawTerms) {
    const terms = splitTerms(rawTerms);
    if (!terms.length) return null;
    const value = normalize(text).toLocaleLowerCase();
    return terms.some((term) => value.includes(term));
  }

  function groupMatches(item, group) {
    const includeChecks = [
      groupMatchesField(item.title, group.titleInclude),
      groupMatchesField(item.agency, group.agencyInclude),
    ].filter((value) => value !== null);
    const includeMatches =
      !includeChecks.length ||
      (group.includeJoin === 'OR'
        ? includeChecks.some(Boolean)
        : includeChecks.every(Boolean));
    if (!includeMatches) return false;

    const excludeChecks = [
      groupMatchesField(item.title, group.titleExclude),
      groupMatchesField(item.agency, group.agencyExclude),
    ].filter((value) => value !== null);
    const excluded =
      excludeChecks.length > 0 &&
      (group.excludeJoin === 'AND'
        ? excludeChecks.every(Boolean)
        : excludeChecks.some(Boolean));
    return !excluded;
  }

  function includeTermsForItem(item, sets) {
    const matchingGroups = sets.activeGroups.filter(
      (group) =>
        (state.activeResultId === 'all' || group.id === state.activeResultId) &&
        groupMatches(item, group),
    );
    const titleTerms = new Set();
    const agencyTerms = new Set();
    matchingGroups.forEach((group) => {
      splitTerms(group.titleInclude).forEach((term) => titleTerms.add(term));
      splitTerms(group.agencyInclude).forEach((term) => agencyTerms.add(term));
    });
    return {
      title: Array.from(titleTerms),
      agency: Array.from(agencyTerms),
    };
  }

  function rowsForGroup(group) {
    return state.items.filter((item) => groupMatches(item, group));
  }

  function groupHasCriteria(group) {
    return [
      group.titleInclude,
      group.agencyInclude,
      group.titleExclude,
      group.agencyExclude,
    ].some((value) => splitTerms(value).length > 0);
  }

  function resultSets() {
    const activeGroups = state.appliedGroups.filter(
      (group) => group.enabled && groupHasCriteria(group),
    );
    const byGroup = activeGroups.map((group) => ({
      group,
      rows: rowsForGroup(group),
    }));
    const union = new Map();
    byGroup.forEach(({ rows }) =>
      rows.forEach((item) => union.set(itemKey(item), item)),
    );
    const allRows = activeGroups.length
      ? Array.from(union.values())
      : state.items.slice();
    return { activeGroups, byGroup, allRows };
  }

  function visibleRows() {
    const sets = resultSets();
    if (state.activeResultId === 'all') return sets.allRows;
    const selected = sets.byGroup.find(
      ({ group }) => group.id === state.activeResultId,
    );
    return selected ? selected.rows : sets.allRows;
  }

  function renderResultTabs(sets) {
    const host = byId('resultTabs');
    host.replaceChildren();
    const tabs = [
      { id: 'all', label: '全部結果', count: sets.allRows.length },
    ].concat(
      sets.byGroup.map(({ group, rows }) => ({
        id: group.id,
        label: group.name || '查詢組合',
        count: rows.length,
      })),
    );
    if (!tabs.some((tab) => tab.id === state.activeResultId))
      state.activeResultId = 'all';
    tabs.forEach((tab) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className =
        'result-tab' + (tab.id === state.activeResultId ? ' is-active' : '');
      button.setAttribute('role', 'tab');
      button.setAttribute(
        'aria-selected',
        String(tab.id === state.activeResultId),
      );
      button.textContent = tab.label + ' (' + tab.count.toLocaleString() + ')';
      button.addEventListener('click', () => {
        state.activeResultId = tab.id;
        render();
      });
      host.append(button);
    });
  }

  function setDataset(payload) {
    state.selected.clear();
    state.detailTexts = [];
    state.date = normalizeDate(payload.from || payload.date, todayInTaipei());
    state.dateTo = normalizeDate(payload.to || payload.date, state.date);
    state.loadError = payload.message || '';
    const seenItems = new Set();
    state.items = Array.isArray(payload.items)
      ? payload.items
          .filter((item) => item && item.id && item.title)
          .map((item) => ({
            ...item,
            date: normalizeDate(item.date, state.date),
          }))
          .filter((item) => {
            const key = itemKey(item);
            if (seenItems.has(key)) return false;
            seenItems.add(key);
            return true;
          })
          .sort((left, right) => right.date.localeCompare(left.date))
      : [];
    byId('detailResults').replaceChildren();
    byId('copyDetails').disabled = true;
    byId('detailsStatus').textContent = '請先選擇標案';
    byId('fetchDetails').disabled = true;
    applyFilters();
  }

  async function loadArchive() {
    const response = await fetch('./data/recent.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('找不到每日標案資料，請稍後重新整理');
    const archive = await response.json();
    if (!archive || !Array.isArray(archive.items)) {
      throw new Error('每日標案資料格式錯誤');
    }
    state.archiveItems = archive.items
      .filter((item) => item && item.id && item.title)
      .map((item) => ({ ...item, date: normalizeDate(item.date) }))
      .filter((item) => item.date);
    return archive;
  }

  async function loadDateRange(from, to) {
    if (state.detailsLoading) return;
    const version = ++state.dateLoadVersion;
    state.dateLoading = true;
    setDateControlsDisabled(state.detailsLoading);
    state.date = from;
    state.dateTo = to;
    state.loadError = '';
    state.items = [];
    state.selected.clear();
    state.detailTexts = [];
    byId('detailResults').replaceChildren();
    byId('copyDetails').disabled = true;
    byId('detailsStatus').textContent = '請先選擇標案';
    render();
    try {
      await state.archivePromise;
      if (version !== state.dateLoadVersion) return;
      const items = state.archiveItems.filter(
        (item) =>
          item.date >= from &&
          item.date <= to &&
          ALLOWED_ANNOUNCEMENT_TYPES.has(normalize(item.type)),
      );
      setDataset({
        from,
        to,
        items,
        message: items.length ? '' : '所選日期沒有符合原有公告類型的標案資料',
      });
    } catch (error) {
      if (version !== state.dateLoadVersion) return;
      setDataset({
        from,
        to,
        items: [],
        message: error.message || '公告資料載入失敗，請稍後再試',
      });
    } finally {
      if (version === state.dateLoadVersion) {
        state.dateLoading = false;
        setDateControlsDisabled(state.detailsLoading);
        render();
      }
    }
  }

  function setupDateControls() {
    const today = todayInTaipei();
    const oldest = shiftDate(today, -13);
    ['dateFrom', 'dateTo'].forEach((id) => {
      byId(id).min = oldest;
      byId(id).max = today;
      byId(id).value = today;
    });
    document.querySelectorAll('[data-date-mode]').forEach((button) => {
      button.addEventListener('click', () => {
        state.dateMode = button.dataset.dateMode;
        document.querySelectorAll('[data-date-mode]').forEach((entry) => {
          const active = entry === button;
          entry.classList.toggle('is-active', active);
          entry.setAttribute('aria-pressed', String(active));
        });
        byId('customDateRange').hidden = state.dateMode !== 'custom';
        if (state.dateMode === 'custom') {
          if (!byId('dateFrom').value)
            byId('dateFrom').value = state.date || today;
          if (!byId('dateTo').value)
            byId('dateTo').value = state.dateTo || today;
        }
      });
    });
  }

  function setDateControlsDisabled(disabled) {
    const shouldDisable = disabled || state.dateLoading;
    document.querySelectorAll('[data-date-mode]').forEach((button) => {
      button.disabled = shouldDisable;
    });
    byId('dateFrom').disabled = shouldDisable;
    byId('dateTo').disabled = shouldDisable;
    byId('applyFilters').disabled = shouldDisable;
  }

  function appendHighlightedText(container, value, terms) {
    const text = normalize(value);
    const uniqueTerms = Array.from(new Set((terms || []).filter(Boolean)));
    if (!text || !uniqueTerms.length) {
      container.textContent = text;
      return;
    }

    const searchableText = text.toLocaleLowerCase();
    const ranges = [];
    uniqueTerms.forEach((term) => {
      let start = 0;
      while ((start = searchableText.indexOf(term, start)) !== -1) {
        ranges.push([start, start + term.length]);
        start += Math.max(term.length, 1);
      }
    });
    if (!ranges.length) {
      container.textContent = text;
      return;
    }

    ranges.sort((left, right) => left[0] - right[0] || right[1] - left[1]);
    const mergedRanges = [];
    ranges.forEach(([start, end]) => {
      const previous = mergedRanges[mergedRanges.length - 1];
      if (previous && start <= previous[1]) {
        previous[1] = Math.max(previous[1], end);
      } else {
        mergedRanges.push([start, end]);
      }
    });

    let cursor = 0;
    mergedRanges.forEach(([start, end]) => {
      if (start > cursor) {
        container.append(document.createTextNode(text.slice(cursor, start)));
      }
      const mark = document.createElement('mark');
      mark.className = 'include-keyword-highlight';
      mark.textContent = text.slice(start, end);
      container.append(mark);
      cursor = end;
    });
    if (cursor < text.length) {
      container.append(document.createTextNode(text.slice(cursor)));
    }
  }

  function makeCell(text, className, highlightTerms = []) {
    const cell = document.createElement('td');
    if (className) cell.className = className;
    appendHighlightedText(cell, normalize(text) || '—', highlightTerms);
    return cell;
  }

  function toggleSelection(item) {
    if (state.detailsLoading) return;
    const key = itemKey(item);
    if (state.selected.has(key)) {
      state.selected.delete(key);
    } else if (state.selected.size < MAX_SELECTIONS) {
      state.selected.set(key, item);
    }
    render();
  }

  function render() {
    const sets = resultSets();
    const rows = visibleRows();
    const body = byId('tenderRows');
    const fragment = document.createDocumentFragment();
    body.replaceChildren();
    renderResultTabs(sets);
    byId('visibleCount').textContent =
      '顯示 ' +
      rows.length.toLocaleString() +
      ' / ' +
      state.items.length.toLocaleString() +
      ' 件 · 已選 ' +
      state.selected.size +
      ' / ' +
      MAX_SELECTIONS +
      ' 件';
    byId('fetchDetails').disabled =
      state.selected.size === 0 || state.detailsLoading;
    byId('downloadExcel').disabled = rows.length === 0;
    byId('emptyList').hidden = rows.length > 0;
    byId('emptyList').classList.toggle('is-loading', state.dateLoading);

    if (!rows.length) {
      byId('emptyList').textContent = state.dateLoading
        ? '正在載入標案資料，請稍候…'
        : state.items.length
          ? '此結果分頁沒有符合條件的標案'
          : state.loadError || '目前沒有可顯示的標案';
    }

    rows.forEach((item) => {
      const row = document.createElement('tr');
      const key = itemKey(item);
      const highlightTerms = includeTermsForItem(item, sets);
      if (state.selected.has(key)) row.classList.add('is-selected');
      row.addEventListener('click', () => {
        const selection = window.getSelection();
        if (selection && !selection.isCollapsed && selection.toString()) return;
        toggleSelection(item);
      });

      const selectCell = document.createElement('td');
      selectCell.className = 'select-column';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'tender-checkbox';
      checkbox.setAttribute('aria-label', '選取 ' + normalize(item.title));
      checkbox.checked = state.selected.has(key);
      checkbox.disabled =
        !checkbox.checked && state.selected.size >= MAX_SELECTIONS;
      checkbox.addEventListener('click', (event) => event.stopPropagation());
      checkbox.addEventListener('change', () => toggleSelection(item));
      selectCell.append(checkbox);
      row.append(selectCell);

      row.append(
        makeCell(item.date.replace(/-/g, '/')),
        makeCell(item.type),
        makeCell(item.agency, '', highlightTerms.agency),
      );

      const titleCell = document.createElement('td');
      const isToday = normalizeDate(item.date, state.date) === todayInTaipei();
      const titleLink = document.createElement(isToday ? 'a' : 'span');
      titleLink.className = 'tender-title-text';
      if (isToday) {
        titleLink.href = officialUrl(item);
        titleLink.target = '_blank';
        titleLink.rel = 'noopener noreferrer';
      }
      appendHighlightedText(
        titleLink,
        normalize(item.title) || '查看公告',
        highlightTerms.title,
      );
      const caseNumber = normalize(item.id);
      if (caseNumber) {
        titleLink.title = '案號：' + caseNumber;
        titleLink.setAttribute(
          'aria-label',
          normalize(item.title) + '，案號：' + caseNumber,
        );
      }
      titleLink.addEventListener('click', (event) => {
        event.stopPropagation();
        if (normalizeDate(item.date, state.date) !== todayInTaipei()) {
          event.preventDefault();
        }
      });
      titleCell.append(titleLink);
      row.append(titleCell);
      fragment.append(row);
    });
    body.append(fragment);
  }

  function applyFilters() {
    if (state.detailsLoading) return;
    state.appliedGroups = state.groups.map(copyGroup);
    state.activeResultId = 'all';
    state.selected.clear();
    byId('detailResults').replaceChildren();
    state.detailTexts = [];
    byId('copyDetails').disabled = true;
    byId('detailsStatus').textContent = '請先選擇標案';
    render();
  }

  function applySelectedDateAndFilters() {
    if (state.detailsLoading) return;
    const today = todayInTaipei();
    const oldest = shiftDate(today, -13);
    let from;
    let to;

    if (state.dateMode === 'today') {
      from = today;
      to = today;
    } else if (state.dateMode === 'last14') {
      from = oldest;
      to = today;
    } else {
      from = normalizeDate(byId('dateFrom').value);
      to = normalizeDate(byId('dateTo').value);
      const invalid =
        !from ||
        !to ||
        from > to ||
        from < oldest ||
        to > today ||
        Math.round(
          (Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) /
            86400000,
        ) >= 14;
      if (invalid) return;
    }

    if (from !== state.date || to !== state.dateTo) {
      loadDateRange(from, to);
      return;
    }
    applyFilters();
  }

  function resetFilters() {
    if (state.detailsLoading) return;
    if (!window.confirm('確定清除此查詢組合內容？')) return;
    const group = state.groups.find(
      (entry) => entry.id === state.activeGroupId,
    );
    if (!group) return;
    group.titleInclude = '';
    group.agencyInclude = '';
    group.titleExclude = '';
    group.agencyExclude = '';
    group.includeJoin = 'AND';
    group.excludeJoin = 'AND';
    saveGroups();
    renderGroupTabs();
    renderGroupEditor();
    state.activeResultId = 'all';
    state.selected.clear();
    state.detailTexts = [];
    byId('detailResults').replaceChildren();
    byId('copyDetails').disabled = true;
    byId('detailsStatus').textContent = '';
    applyFilters();
  }

  function requestApi(action, params) {
    return new Promise((resolve, reject) => {
      if (
        !/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(
          APPS_SCRIPT_URL,
        )
      ) {
        reject(new Error('尚未設定部署網址'));
        return;
      }

      const callbackName =
        '__tenderApi_' + Date.now() + '_' + Math.random().toString(36).slice(2);
      const script = document.createElement('script');
      const endpoint = new URL(APPS_SCRIPT_URL);
      endpoint.searchParams.set('action', action);
      Object.keys(params || {}).forEach((key) => {
        endpoint.searchParams.set(key, String(params[key]));
      });
      endpoint.searchParams.set('callback', callbackName);

      let settled = false;
      let timeoutId;
      function cleanup() {
        if (timeoutId) window.clearTimeout(timeoutId);
        delete window[callbackName];
        script.remove();
      }
      function fail(error) {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      }

      window[callbackName] = (payload) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (payload && payload.error) {
          reject(new Error(payload.error));
          return;
        }
        resolve(payload);
      };
      script.onerror = () =>
        fail(new Error('無法連線到，請確認部署網址和存取權限'));
      timeoutId = window.setTimeout(
        () => fail(new Error('回應逾時，請稍後再試')),
        30000,
      );
      script.src = endpoint.toString();
      document.head.append(script);
    });
  }

  function getApiTitle(record) {
    if (record.brief && typeof record.brief === 'object')
      return normalize(record.brief.title);
    return normalize(record.title || '');
  }

  function getApiType(record) {
    if (record.brief && typeof record.brief === 'object')
      return normalize(record.brief.type);
    return normalize(record.type || '');
  }

  function getApiRecords(payload) {
    if (Array.isArray(payload)) return payload;
    return Array.isArray(payload.records) ? payload.records : [];
  }

  function comparableText(value) {
    return normalize(value)
      .replace(/[\s\u3000]+/g, '')
      .toLocaleLowerCase();
  }

  function agencyMatches(apiAgency, sourceAgency) {
    const apiName = comparableText(apiAgency);
    const sourceName = comparableText(sourceAgency);
    return Boolean(
      apiName &&
      sourceName &&
      (apiName === sourceName ||
        apiName.includes(sourceName) ||
        sourceName.includes(apiName)),
    );
  }

  function matchApiRecord(item, records) {
    const itemNumber = normalize(item.id);
    const itemTitle = comparableText(item.title);
    const itemType = comparableText(item.type);
    const itemFilename = normalize(item.filename);
    if (itemFilename) {
      const itemUnitId = normalize(item.unit_id);
      const filenameMatches = records.filter(
        (record) =>
          normalize(record.filename) === itemFilename &&
          (!itemUnitId || normalize(record.unit_id) === itemUnitId),
      );
      if (filenameMatches.length === 1) return filenameMatches[0];
    }
    const expectedDate = normalizeDate(item.date);
    const sameDateRecords = expectedDate
      ? records.filter((record) => normalizeDate(record.date) === expectedDate)
      : [];
    const sourceRecords = sameDateRecords.length ? sameDateRecords : records;
    const candidates = sourceRecords
      .map((record) => {
        const apiNumber = normalize(record.job_number);
        const apiTitle = comparableText(getApiTitle(record));
        const apiAgency = normalize(record.unit_name);
        const sameNumber = Boolean(
          itemNumber && apiNumber && apiNumber === itemNumber,
        );
        const sameTitle = Boolean(
          itemTitle && apiTitle && apiTitle === itemTitle,
        );
        const sameAgency = agencyMatches(apiAgency, item.agency);

        // Reject an explicit case-number mismatch; title searches can return similar notices.
        if (apiNumber && itemNumber && !sameNumber) return { record, score: 0 };
        if (sameNumber && sameTitle && (!apiAgency || sameAgency))
          return { record, score: 5 };
        if (sameNumber && sameAgency) return { record, score: 4 };
        if (sameNumber && sameTitle) return { record, score: 3 };
        if (sameTitle && sameAgency) return { record, score: 4 };
        if (sameTitle && !apiAgency) return { record, score: 2 };
        return { record, score: 0 };
      })
      .filter((candidate) => candidate.score > 0);

    if (!candidates.length) return null;
    const bestScore = Math.max(
      ...candidates.map((candidate) => candidate.score),
    );
    let best = candidates
      .filter((candidate) => candidate.score === bestScore)
      .map((candidate) => candidate.record);
    // Use notice type only to break a tie among equally ranked matches.
    if (best.length > 1 && itemType) {
      const typedMatches = best.filter(
        (record) => comparableText(getApiType(record)) === itemType,
      );
      if (typedMatches.length) best = typedMatches;
    }
    const identities = new Set(
      best.map((record) =>
        [normalize(record.unit_id), normalize(record.job_number)].join('|'),
      ),
    );
    if (identities.size !== 1) return null;
    return best.sort((left, right) =>
      normalize(right.date).localeCompare(normalize(left.date)),
    )[0];
  }

  async function findApiRecord(item) {
    // Listing comes from the locally archived daily snapshot; only look up a record
    // when the user explicitly requests details for a selected notice.
    const searchPayload = await requestApi('searchbytitle', {
      query: item.title,
      page: '1',
    });
    return matchApiRecord(item, getApiRecords(searchPayload));
  }

  function chooseAnnouncement(payload, apiIndexRecord, date) {
    const records = getApiRecords(payload);
    if (!records.length) {
      if (payload && payload.detail) return payload;
      throw new Error('沒有回傳公告內容');
    }
    const filename = normalize(apiIndexRecord.filename);
    if (filename) {
      const filenameMatches = records.filter(
        (record) => normalize(record.filename) === filename,
      );
      if (filenameMatches.length) return filenameMatches[0];
    }

    const sourceDate = normalize(apiIndexRecord.date) || normalize(date);
    const dateKey = sourceDate.replace(/-/g, '');
    let candidates = records.filter((record) => {
      const recordDate = normalize(record.date).replace(/-/g, '');
      return !recordDate || recordDate === dateKey;
    });
    if (!candidates.length) {
      throw new Error('沒有回傳相符日期的公告版本');
    }
    const expectedType = comparableText(getApiType(apiIndexRecord));
    // The type is a fallback disambiguator; keep the single date match even if labels differ.
    if (candidates.length > 1 && expectedType) {
      const typedMatches = candidates.filter(
        (record) => comparableText(getApiType(record)) === expectedType,
      );
      if (typedMatches.length) candidates = typedMatches;
    }
    return candidates[0];
  }

  function flatten(value, path, result) {
    if (value == null || value === '') return;
    if (Array.isArray(value)) {
      value.forEach((entry, index) =>
        flatten(
          entry,
          path ? path + ':' + (index + 1) : String(index + 1),
          result,
        ),
      );
      return;
    }
    if (typeof value === 'object') {
      Object.keys(value).forEach((key) =>
        flatten(value[key], path ? path + ':' + key : key, result),
      );
      return;
    }
    result.push([path, normalize(value)]);
  }

  function pickField(entries, labels) {
    for (const label of labels) {
      const match = entries.find(
        (entry) => entry[0] === label || entry[0].endsWith(':' + label),
      );
      if (match && match[1]) return match[1];
    }
    for (const label of labels) {
      const match = entries.find(
        (entry) => entry[0].includes(label) && entry[1],
      );
      if (match) return match[1];
    }
    return '';
  }

  function announcementFields(announcement, apiRecord, item) {
    const detail = announcement.detail || announcement;
    const entries = [];
    flatten(detail, '', entries);
    const briefTitle = getApiTitle(apiRecord);
    return {
      agency:
        pickField(entries, ['機關名稱']) ||
        normalize(apiRecord.unit_name) ||
        normalize(item.agency),
      unit: pickField(entries, ['單位名稱', '單位']) || '未提供',
      title:
        pickField(entries, ['標案名稱']) || briefTitle || normalize(item.title),
      number: normalize(apiRecord.job_number) || normalize(item.id),
      budget: pickField(entries, ['預算金額', '預算金額是否公開']) || '未提供',
      deadline:
        pickField(entries, ['截止投標', '投標截止日期', '截止日期']) ||
        normalize(item.deadline) ||
        '未提供',
      category:
        typeof apiRecord.brief?.category === 'string'
          ? apiRecord.brief.category.trim()
          : '',
      method: pickField(entries, ['招標方式']) || '未提供',
      awardMethod: pickField(entries, ['決標方式']) || '未提供',
      url: validOfficialUrl(detail.url) || officialUrl(item),
    };
  }

  function formatDetails(fields) {
    return [
      fields.agency,
      fields.unit,
      fields.category,
      fields.budget,
      fields.deadline,
      fields.method,
      fields.awardMethod,
    ]
      .filter((value) => value && value !== '未提供')
      .join('\n');
  }

  function createDetailCard(item, index) {
    const card = document.createElement('article');
    card.className = 'detail-card';
    const heading = document.createElement('h3');
    heading.textContent =
      index + 1 + '. ' + normalize(item.title) + '｜' + normalize(item.id);
    const status = document.createElement('p');
    status.className = 'muted detail-status';
    status.textContent = '等待查詢…';
    const pre = document.createElement('pre');
    const urlLink = document.createElement('a');
    urlLink.className = 'detail-url';
    urlLink.target = '_blank';
    urlLink.rel = 'noopener noreferrer';
    urlLink.hidden = true;
    card.append(heading, status, pre, urlLink);
    byId('detailResults').append(card);
    return { heading, status, pre, urlLink };
  }

  async function loadDetailsFor(item, apiRecord) {
    if (!apiRecord.unit_id) throw new Error('沒有此案的機關代碼');
    const payload = await requestApi('tender', {
      unit_id: apiRecord.unit_id,
      job_number: apiRecord.job_number || item.id,
    });
    const announcement = chooseAnnouncement(payload, apiRecord, item.date);
    return announcementFields(announcement, apiRecord, item);
  }

  async function queryDetails() {
    const items = Array.from(state.selected.values());
    if (!items.length) return;
    state.detailsLoading = true;
    setDateControlsDisabled(true);
    render();
    state.detailTexts = new Array(items.length);
    byId('detailResults').replaceChildren();
    byId('copyDetails').disabled = true;
    byId('fetchDetails').disabled = true;
    byId('detailsStatus').textContent = '正在查詢 ' + items.length + ' 件標案…';
    byId('detailsPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    const cards = items.map(createDetailCard);

    try {
      let cursor = 0;
      let completed = 0;
      async function worker() {
        while (cursor < items.length) {
          const index = cursor;
          cursor += 1;
          const item = items[index];
          const card = cards[index];
          try {
            const apiRecord = await findApiRecord(item);
            if (!apiRecord)
              throw new Error(
                '找不到相符的標案資料，請核對案號、機關及標案名稱',
              );
            const fields = await loadDetailsFor(item, apiRecord);
            const text = formatDetails(fields);
            state.detailTexts[index] = [
              card.heading.textContent,
              fields.agency,
              fields.unit,
              fields.category,
              fields.budget,
              fields.deadline,
              fields.method,
              fields.awardMethod,
              fields.url,
            ]
              .filter((value) => value && value !== '未提供')
              .join('\n');
            card.status.hidden = true;
            card.pre.textContent = text;
            card.urlLink.href = fields.url;
            card.urlLink.textContent = fields.url;
            card.urlLink.hidden = !fields.url;
          } catch (error) {
            const message =
              error && error.name === 'AbortError'
                ? '查詢逾時，請稍後再試'
                : '此標案詳細資料暫時無法載入，請稍後再試';
            card.status.textContent = message;
            card.status.classList.add('status-error');
            card.pre.textContent = normalize(item.agency);
          }
          completed += 1;
          byId('detailsStatus').textContent =
            '已完成 ' + completed + ' / ' + items.length + ' 件';
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(3, items.length) }, worker),
      );
    } catch (error) {
      const message =
        error && error.name === 'AbortError'
          ? '查詢逾時，請稍後再試'
          : '標案詳細資料暫時無法載入，請稍後再試';
      cards.forEach((card) => {
        card.status.textContent = message;
        card.status.classList.add('status-error');
      });
      byId('detailsStatus').textContent = message;
    } finally {
      state.detailTexts = state.detailTexts.filter(Boolean);
      state.detailsLoading = false;
      setDateControlsDisabled(false);
      byId('copyDetails').disabled = state.detailTexts.length === 0;
      byId('fetchDetails').disabled = state.selected.size === 0;
      render();
    }
  }

  async function copyDetails() {
    if (!state.detailTexts.length) return;
    const text = state.detailTexts
      .map((details) => details.replace(/\r?\n/g, '\r\n'))
      .join('\r\n\r\n');
    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch (_) {
      const input = document.createElement('textarea');
      input.value = text;
      input.setAttribute('readonly', '');
      input.style.position = 'fixed';
      input.style.left = '-9999px';
      document.body.append(input);
      input.select();
      try {
        copied = document.execCommand('copy');
      } catch (_) {}
      input.remove();
    }
    const button = byId('copyDetails');
    button.textContent = copied ? '已複製' : '複製失敗';
    window.setTimeout(() => {
      button.textContent = '複製結果';
    }, 1800);
  }

  function downloadExcel() {
    const rows = visibleRows();
    if (!rows.length) return;
    if (!window.XLSX) {
      window.alert('元件尚未載入，請重新整理後再試');
      return;
    }

    const values = [
      ['公告日期', '公告類型', '機關名稱', '標案名稱', '標案案號'],
      ...rows.map((item) => [
        item.date,
        normalize(item.type),
        normalize(item.agency),
        normalize(item.title),
        normalize(item.id),
      ]),
    ];
    const worksheet = window.XLSX.utils.aoa_to_sheet(values);
    worksheet['!cols'] = [
      { wch: 14 },
      { wch: 32 },
      { wch: 30 },
      { wch: 60 },
      { wch: 20 },
    ];
    const workbook = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(workbook, worksheet, '篩選標案');
    const date =
      state.date === state.dateTo
        ? (state.date || todayInTaipei()).replace(/-/g, '')
        : state.date.replace(/-/g, '') + '-' + state.dateTo.replace(/-/g, '');
    window.XLSX.writeFile(workbook, '篩選標案_' + date + '.xlsx', {
      compression: true,
    });
  }

  function setupCollapsibleSections() {
    document.querySelectorAll('.collapse-toggle').forEach((button) => {
      button.addEventListener('click', () => {
        const expanded = button.getAttribute('aria-expanded') === 'true';
        const nextExpanded = !expanded;
        const content = byId(button.getAttribute('aria-controls'));
        const section = button.closest('[data-collapsible]');
        button.setAttribute('aria-expanded', String(nextExpanded));
        button.setAttribute(
          'aria-label',
          (nextExpanded ? '收合' : '展開') + button.dataset.label,
        );
        section.classList.toggle('is-collapsed', !nextExpanded);
        content.hidden = !nextExpanded;
      });
    });
  }

  function setupBackToTop() {
    const button = byId('backToTop');
    const updateVisibility = () => {
      button.hidden = window.scrollY < 320;
    };
    button.addEventListener('click', () => {
      const reduceMotion = window.matchMedia(
        '(prefers-reduced-motion: reduce)',
      ).matches;
      window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
    });
    window.addEventListener('scroll', updateVisibility, { passive: true });
    updateVisibility();
  }

  byId('applyFilters').addEventListener('click', applySelectedDateAndFilters);
  byId('resetFilters').addEventListener('click', resetFilters);
  byId('importFilterGroups').addEventListener('click', () => {
    byId('filterGroupsFile').click();
  });
  byId('filterGroupsFile').addEventListener('change', importFilterGroups);
  byId('exportFilterGroups').addEventListener('click', downloadFilterGroups);
  byId('addFilterGroup').addEventListener('click', () => {
    const group = newFilterGroup('查詢組合 ' + (state.groups.length + 1));
    state.groups.push(group);
    state.activeGroupId = group.id;
    saveGroups();
    renderGroupTabs();
    renderGroupEditor();
  });
  byId('clearSelection').addEventListener('click', () => {
    if (state.detailsLoading) return;
    state.selected.clear();
    render();
  });
  byId('fetchDetails').addEventListener('click', queryDetails);
  byId('copyDetails').addEventListener('click', copyDetails);
  byId('downloadExcel').addEventListener('click', downloadExcel);

  setupCollapsibleSections();
  setupBackToTop();
  loadGroups();
  renderGroupTabs();
  renderGroupEditor();
  setupDateControls();
  state.archivePromise = loadArchive();
  loadDateRange(todayInTaipei(), todayInTaipei());

  window.TenderApp = {
    loadCollected(payload) {
      const today = todayInTaipei();
      if (!payload || !Array.isArray(payload.items)) return;
      setDataset({
        date: payload.date || today,
        to: payload.date || today,
        items: payload.items,
        status: 'success',
      });
      applyFilters();
    },
  };
})();
