const state = {
    episodes: [],
    selectedEpisode: null,
    utterances: [],
    token: localStorage.getItem('episodeTranscriptToken') || ''
};

const episodeList = document.getElementById('episode-list');
const episodeCount = document.getElementById('episode-count');
const episodeFilter = document.getElementById('episode-filter');
const transcriptFilter = document.getElementById('transcript-filter');
const transcript = document.getElementById('transcript');
const episodeTitle = document.getElementById('episode-title');
const episodeMeta = document.getElementById('episode-meta');
const parseErrors = document.getElementById('parse-errors');
const authPanel = document.getElementById('auth-panel');
const authToken = document.getElementById('auth-token');
const saveToken = document.getElementById('save-token');

function apiBase() {
    const pathname = window.location.pathname.replace(/\/index\.html$/, '/');
    const base = pathname.endsWith('/') ? pathname : `${pathname}/`;
    return `${base}api`;
}

function authHeaders() {
    return state.token ? { Authorization: `Bearer ${state.token}` } : {};
}

function consumeTokenFromUrl() {
    const token = readTokenFromParams(window.location.hash) || readTokenFromParams(window.location.search);
    if (!token) return;

    state.token = token;
    localStorage.setItem('episodeTranscriptToken', token);

    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete('token');
    cleanUrl.searchParams.delete('access_token');
    cleanUrl.hash = '';
    window.history.replaceState(null, document.title, cleanUrl.toString());
}

function readTokenFromParams(value) {
    const params = new URLSearchParams(String(value || '').replace(/^[?#]/, ''));
    return (params.get('token') || params.get('access_token') || '').trim();
}

async function fetchJson(url) {
    const response = await fetch(url, { headers: authHeaders() });
    if (response.status === 401) {
        authPanel.classList.remove('hidden');
        throw new Error('Access token required');
    }
    if (!response.ok) {
        throw new Error(`Request failed: ${response.status}`);
    }
    return response.json();
}

async function loadEpisodes() {
    try {
        const data = await fetchJson(`${apiBase()}/episodes`);
        state.episodes = data.episodes || [];
        episodeCount.textContent = `${state.episodes.length} episode${state.episodes.length === 1 ? '' : 's'}`;
        renderEpisodeList();
        if (state.episodes[0]) {
            await selectEpisode(state.episodes[0].id);
        }
    } catch (error) {
        episodeCount.textContent = error.message;
        renderEmpty(error.message);
    }
}

async function selectEpisode(id) {
    state.selectedEpisode = id;
    renderEpisodeList();
    renderEmpty('Loading transcript...');

    try {
        const data = await fetchJson(`${apiBase()}/episodes/${encodeURIComponent(id)}`);
        state.utterances = data.utterances || [];
        episodeTitle.textContent = data.episode?.id || id;
        episodeMeta.textContent = formatEpisodeMeta(data.episode);
        renderParseErrors(data.parseErrors || []);
        renderTranscript();
    } catch (error) {
        renderEmpty(error.message);
    }
}

function renderEpisodeList() {
    const query = episodeFilter.value.trim().toLowerCase();
    episodeList.replaceChildren();

    state.episodes
        .filter((episode) => !query || episode.id.toLowerCase().includes(query))
        .forEach((episode) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'episode-button';
            button.setAttribute('aria-current', episode.id === state.selectedEpisode ? 'true' : 'false');
            button.addEventListener('click', () => selectEpisode(episode.id));

            const title = document.createElement('strong');
            title.textContent = episode.id;
            const meta = document.createElement('span');
            meta.textContent = [
                formatDate(episode.startedAt),
                `${episode.transcriptCount || 0} turns`,
                `${episode.internalThoughtCount || 0} thoughts`
            ].filter(Boolean).join(' | ');

            button.append(title, meta);
            episodeList.append(button);
        });
}

function renderTranscript() {
    const query = transcriptFilter.value.trim().toLowerCase();
    const visible = state.utterances.filter((utterance) => {
        if (!query) return true;
        return [
            utterance.speaker,
            utterance.text,
            ...(utterance.injectedThoughts || []).map((thought) => thought.internalThought)
        ].join(' ').toLowerCase().includes(query);
    });

    transcript.classList.toggle('empty', visible.length === 0);
    transcript.replaceChildren();

    if (visible.length === 0) {
        transcript.textContent = 'No transcript turns match the current filter.';
        return;
    }

    visible.forEach((utterance) => {
        transcript.append(renderUtterance(utterance));
    });
}

function renderUtterance(utterance) {
    const row = document.createElement('article');
    row.className = `utterance ${isHost(utterance) ? 'host' : 'guest'}`;

    const time = document.createElement('div');
    time.className = 'time';
    time.textContent = utterance.displayTime || '--:--:--';

    const bubble = document.createElement('div');
    bubble.className = 'bubble';

    const speaker = document.createElement('div');
    speaker.className = 'speaker';
    const dot = document.createElement('span');
    dot.className = 'role-dot';
    dot.setAttribute('aria-hidden', 'true');
    const name = document.createElement('strong');
    name.textContent = utterance.speaker || 'Unknown';
    speaker.append(dot, name);
    bubble.append(speaker);

    if (isHost(utterance) && utterance.injectedThoughts?.length) {
        const subheading = document.createElement('div');
        subheading.className = 'thought-subheading';
        const emphasis = document.createElement('em');
        emphasis.textContent = formatThoughtSubheading(utterance.injectedThoughts);
        subheading.append(emphasis);
        bubble.append(subheading);
    }

    const text = document.createElement('div');
    text.className = 'utterance-text';
    text.textContent = utterance.text || '';
    bubble.append(text);

    if (isHost(utterance) && utterance.injectedThoughts?.length) {
        bubble.append(renderThoughtDetails(utterance.injectedThoughts));
    }

    row.append(time, bubble);
    return row;
}

function renderThoughtDetails(thoughts) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = thoughts.length === 1 ? 'Injected awareness' : 'Injected awareness notes';
    details.append(summary);

    const body = document.createElement('div');
    body.className = 'details-body';
    thoughts.forEach((thought) => {
        if (thought.awarenessInjection) {
            const injection = document.createElement('p');
            injection.textContent = `Awareness: ${thought.awarenessInjection}`;
            body.append(injection);
        }
        if (thought.reason) {
            const reason = document.createElement('p');
            reason.textContent = `Reason: ${thought.reason}`;
            body.append(reason);
        }
    });
    details.append(body);
    return details;
}

function formatThoughtSubheading(thoughts) {
    const text = thoughts
        .map((thought) => thought.internalThought || thought.awarenessInjection)
        .filter(Boolean)
        .join(' / ');
    return thoughts.length === 1
        ? `Internal thought: ${text}`
        : `Internal thoughts: ${text}`;
}

function renderParseErrors(errors) {
    parseErrors.classList.toggle('hidden', errors.length === 0);
    parseErrors.replaceChildren();
    errors.forEach((error) => {
        const line = document.createElement('p');
        line.textContent = error;
        parseErrors.append(line);
    });
}

function renderEmpty(message) {
    transcript.classList.add('empty');
    transcript.replaceChildren();
    transcript.textContent = message;
}

function formatEpisodeMeta(episode) {
    if (!episode) return 'Episode';
    return [
        formatDate(episode.startedAt),
        episode.duration ? `${Math.round(episode.duration)} seconds` : '',
        `${episode.transcriptCount || 0} turns`,
        `${episode.internalThoughtCount || 0} thoughts`
    ].filter(Boolean).join(' | ');
}

function formatDate(value) {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function isHost(utterance) {
    return utterance.speakerRole === 'host' || /^alpha-clawd$/i.test(utterance.speaker || '');
}

episodeFilter.addEventListener('input', renderEpisodeList);
transcriptFilter.addEventListener('input', renderTranscript);
saveToken.addEventListener('click', () => {
    state.token = authToken.value.trim();
    localStorage.setItem('episodeTranscriptToken', state.token);
    authPanel.classList.add('hidden');
    loadEpisodes();
});

consumeTokenFromUrl();
authToken.value = state.token;
loadEpisodes();
