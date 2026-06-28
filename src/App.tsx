import { type CSSProperties, type FormEvent, type PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { isFirebaseConfigured } from "./firebaseClient";
import {
  activateQuestion as activateFirebaseQuestion,
  addQuestion as addFirebaseQuestion,
  createEvent as createFirebaseEvent,
  deleteQuestion as deleteFirebaseQuestion,
  deleteEvent as deleteFirebaseEvent,
  getLogoUrl,
  makeEventLinks,
  resetEvent as resetFirebaseEvent,
  sendMessage as sendFirebaseMessage,
  sendReaction as sendFirebaseReaction,
  subscribeEvent,
  subscribeLiveMessages,
  subscribeLiveReactions,
  subscribeLogo,
  updatePoll as updateFirebasePoll,
  uploadLogo as uploadFirebaseLogo,
  vote as voteFirebase
} from "./firebaseStore";

interface PollOption {
  id: string;
  text: string;
  votes: number;
  percentage: number;
}

interface Poll {
  id: string;
  question: string;
  active: boolean;
  multiple: boolean;
  options: PollOption[];
  totalVotes: number;
}

interface EventStats {
  messages: number;
  reactions?: number;
  hearts?: number;
}

interface EventState {
  id: string;
  name: string;
  createdAt: string;
  activeQuestionId: string;
  poll: Poll;
  questions: Poll[];
  stats: EventStats;
}

interface EventLinks {
  audienceUrl: string;
  displayUrl: string;
  adminUrl: string;
  qr: string;
}

interface RouteState {
  view: "admin" | "audience" | "display";
  eventId: string | null;
}

interface ReactionChoice {
  emoji: string;
  label: string;
}

interface ChatMessagePayload {
  id: string;
  text: string;
  clientId: string;
  createdAt: number;
}

interface DisplayMessage {
  id: string;
  text: string;
  expiresAt: number;
}

interface FloatingReaction {
  id: string;
  emoji: string;
  x: number;
  drift: number;
  spin: number;
  expiresAt: number;
}

interface ToastState {
  id: string;
  message: string;
}

const REACTIONS: ReactionChoice[] = [
  { emoji: "\u2764\ufe0f", label: "Love" },
  { emoji: "\ud83d\udd25", label: "Fire" },
  { emoji: "\ud83d\udc4f", label: "Clap" },
  { emoji: "\ud83d\ude80", label: "Rocket" },
  { emoji: "\ud83e\udd2f", label: "Wow" }
];
const DISPLAY_MESSAGE_LIMIT = 6;
const DISPLAY_FEED_TTL_MS = 4000;
const DISPLAY_REACTION_LIMIT = 12;
const DEFAULT_POLL_QUESTION = "Which topic should we cover next?";
const DEFAULT_POLL_OPTIONS = ["Firebase", "AI/ML", "Cloud Run", "Kubernetes"];

function parseRoute(): RouteState {
  const parts = window.location.pathname.split("/").filter(Boolean);
  const view = parts[0] === "audience" || parts[0] === "display" ? parts[0] : "admin";
  return {
    view,
    eventId: parts[1] || null
  };
}

function makeBrowserId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  if (globalThis.crypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    return [...bytes]
      .map((byte, index) => {
        const value = byte.toString(16).padStart(2, "0");
        return [4, 6, 8, 10].includes(index) ? `-${value}` : value;
      })
      .join("");
  }

  return `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function getClientId() {
  const key = "live-event-client-id";
  let id = localStorage.getItem(key);
  if (!id) {
    id = makeBrowserId();
    localStorage.setItem(key, id);
  }
  return id;
}

function reactionCount(stats: EventStats) {
  return stats.reactions ?? stats.hearts ?? 0;
}

function getVoteKey(eventId: string, questionId: string) {
  return `live-event-vote-${eventId}-${questionId}`;
}

function getSelectedVote(eventId: string, questionId: string) {
  return localStorage.getItem(getVoteKey(eventId, questionId));
}

function setSelectedVote(eventId: string, questionId: string, optionId: string) {
  localStorage.setItem(getVoteKey(eventId, questionId), optionId);
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read logo file"));
    reader.readAsDataURL(file);
  });
}

function makeDisplayMessage(message: ChatMessagePayload): DisplayMessage {
  return {
    id: message.id || makeBrowserId(),
    text: message.text,
    expiresAt: Date.now() + DISPLAY_FEED_TTL_MS
  };
}

function barColor(index: number) {
  const colors = [
    "linear-gradient(90deg, #12b76a, #1570ef)",
    "linear-gradient(90deg, #fdb022, #e31b54)",
    "linear-gradient(90deg, #7a5af8, #2e90fa)",
    "linear-gradient(90deg, #06aed4, #12b76a)",
    "linear-gradient(90deg, #f97066, #fdb022)"
  ];
  return colors[index % colors.length];
}

function App() {
  const route = useMemo(parseRoute, []);
  const clientId = useMemo(getClientId, []);
  const [eventState, setEventState] = useState<EventState | null>(null);
  const [links, setLinks] = useState<EventLinks | null>(null);
  const [logoUrl, setLogoUrl] = useState("/logo.png");
  const [displayMessages, setDisplayMessages] = useState<DisplayMessage[]>([]);
  const [floatingReactions, setFloatingReactions] = useState<FloatingReaction[]>([]);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(route.eventId));

  const showToast = (message: string) => {
    const id = makeBrowserId();
    setToast({ id, message });
    window.setTimeout(() => {
      setToast((current) => (current?.id === id ? null : current));
    }, 2600);
  };

  const refreshLogo = async () => {
    setLogoUrl(await getLogoUrl());
  };

  useEffect(() => {
    let active = true;
    let unsubscribeEvent: (() => void) | undefined;
    let loadingTimer: number | undefined;

    const finishLoading = () => {
      if (loadingTimer) window.clearTimeout(loadingTimer);
      if (active) setLoading(false);
    };

    async function load() {
      try {
        if (!isFirebaseConfigured()) {
          setLoading(false);
          return;
        }
        refreshLogo().catch(() => undefined);
        if (!route.eventId) {
          setLoading(false);
          return;
        }
        const linkData = await makeEventLinks(route.eventId);
        if (!active) return;
        setLinks(linkData);
        loadingTimer = window.setTimeout(() => {
          if (!active) return;
          setError("Event is taking too long to load. Refresh once or check your Firebase connection.");
          setLoading(false);
        }, 12000);
        unsubscribeEvent = subscribeEvent(
          route.eventId,
          (eventData) => {
            if (!active) return;
            setEventState(eventData);
            finishLoading();
          },
          () => {
            if (!active) return;
            setError("Event not found");
            finishLoading();
          },
          (eventError) => {
            if (!active) return;
            setError(eventError.message || "Could not load event");
            finishLoading();
          }
        );
      } catch (loadError) {
        if (active) {
          setError((loadError as Error).message);
          setLoading(false);
        }
      }
    }

    load();
    return () => {
      active = false;
      if (loadingTimer) window.clearTimeout(loadingTimer);
      unsubscribeEvent?.();
    };
  }, [route.eventId]);

  useEffect(() => {
    if (!isFirebaseConfigured()) return;
    return subscribeLogo((nextLogoUrl) => setLogoUrl(nextLogoUrl));
  }, []);

  useEffect(() => {
    if (!isFirebaseConfigured() || route.view !== "display" || !route.eventId) return;

    const handleChat = (message: ChatMessagePayload) => {
      const displayMessage = makeDisplayMessage(message);
      setDisplayMessages((current) => {
        const live = current.filter((item) => item.expiresAt > Date.now());
        return [...live, displayMessage].slice(-DISPLAY_MESSAGE_LIMIT);
      });
      window.setTimeout(() => {
        setDisplayMessages((current) => current.filter((item) => item.id !== displayMessage.id));
      }, DISPLAY_FEED_TTL_MS);
    };
    const handleReaction = ({ emoji }: { emoji?: string } = {}) => {
      const reaction: FloatingReaction = {
        id: makeBrowserId(),
        emoji: emoji || REACTIONS[0].emoji,
        x: 12 + Math.random() * 68,
        drift: Math.round(-60 + Math.random() * 120),
        spin: Math.round(-12 + Math.random() * 24),
        expiresAt: Date.now() + DISPLAY_FEED_TTL_MS
      };
      setFloatingReactions((current) => {
        const live = current.filter((item) => item.expiresAt > Date.now());
        return [...live, reaction].slice(-DISPLAY_REACTION_LIMIT);
      });
      window.setTimeout(() => {
        setFloatingReactions((current) => current.filter((item) => item.id !== reaction.id));
      }, DISPLAY_FEED_TTL_MS);
    };

    const unsubscribeMessages = subscribeLiveMessages(route.eventId, handleChat);
    const unsubscribeReactions = subscribeLiveReactions(route.eventId, handleReaction);

    return () => {
      unsubscribeMessages();
      unsubscribeReactions();
    };
  }, [route.eventId, route.view]);

  if (loading) return <FullMessage message="Loading event" />;
  if (!isFirebaseConfigured()) {
    return <FullMessage message="Firebase is not configured. Add your VITE_FIREBASE_* values in .env.local, then restart npm run dev." />;
  }
  if (error) return <FullMessage message={error} />;

  return (
    <>
      {route.view === "admin" && !route.eventId && (
        <AdminCreate logoUrl={logoUrl} setLogoUrl={setLogoUrl} showToast={showToast} />
      )}
      {route.view === "admin" && route.eventId && eventState && links && (
        <AdminEvent
          eventState={eventState}
          links={links}
          logoUrl={logoUrl}
          setLogoUrl={setLogoUrl}
          showToast={showToast}
        />
      )}
      {route.view === "audience" && eventState && (
        <Audience eventState={eventState} clientId={clientId} logoUrl={logoUrl} showToast={showToast} />
      )}
      {route.view === "display" && eventState && links && (
        <Display
          eventState={eventState}
          links={links}
          logoUrl={logoUrl}
          messages={displayMessages.filter((message) => message.expiresAt > Date.now())}
          reactions={floatingReactions.filter((reaction) => reaction.expiresAt > Date.now())}
        />
      )}
      {toast && <div className="toast">{toast.message}</div>}
    </>
  );
}

function FullMessage({ message }: { message: string }) {
  return (
    <main className="app-shell">
      <div className="workspace">
        <div className="empty-state">{message}</div>
      </div>
    </main>
  );
}

function Shell({ children, eventId }: { children: React.ReactNode; eventId?: string }) {
  return (
    <main className="app-shell">
      <div className="workspace">
        <div className="topbar">
          <div className="brand">
            <div className="mark image-mark">
              <img src="/favicon.png" alt="FOF Kolkata-Polls logo" />
            </div>
            <div>
              <h2>FOF Kolkata-Polls</h2>
              <p className="muted">Realtime event interaction</p>
            </div>
          </div>
          {eventId && (
            <a className="button secondary" href={`/display/${eventId}`} target="_blank" rel="noreferrer">
              Open Display
            </a>
          )}
        </div>
        {children}
      </div>
    </main>
  );
}

function OptionInput({
  value,
  onChange,
  onRemove
}: {
  value: string;
  onChange: (value: string) => void;
  onRemove: () => void;
}) {
  return (
    <div className="option-row">
      <input className="input option-input" value={value} maxLength={80} onChange={(event) => onChange(event.target.value)} />
      <button type="button" className="button secondary icon remove-option" title="Remove option" onClick={onRemove}>
        x
      </button>
    </div>
  );
}

function LogoUpload({
  logoUrl,
  setLogoUrl,
  showToast
}: {
  logoUrl: string;
  setLogoUrl: (value: string) => void;
  showToast: (message: string) => void;
}) {
  const uploadLogo = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const input = form.elements.namedItem("logo") as HTMLInputElement | null;
    const file = input?.files?.[0];
    if (!file) {
      showToast("Choose a PNG logo");
      return;
    }
    if (file.type !== "image/png") {
      showToast("Logo must be PNG");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      showToast("Logo must be 2 MB or smaller");
      return;
    }

    const dataUrl = await readFileAsDataUrl(file);
    const logoUrl = await uploadFirebaseLogo(dataUrl);
    setLogoUrl(logoUrl);
    showToast("Logo uploaded");
    form.reset();
  };

  return (
    <form className="panel panel-pad grid" onSubmit={uploadLogo}>
      <div className="grid" style={{ gap: 8 }}>
        <h2>Logo</h2>
        <p className="muted">Upload PNG, max 2 MB.</p>
      </div>
      <div className="logo-preview">
        <img src={logoUrl} alt="Current event logo" />
      </div>
      <div className="field">
        <label htmlFor="logo-file">Logo PNG</label>
        <input className="input file-input" id="logo-file" name="logo" type="file" accept="image/png" />
      </div>
      <button className="button green" type="submit">
        Upload Logo
      </button>
    </form>
  );
}

function AdminCreate({
  logoUrl,
  setLogoUrl,
  showToast
}: {
  logoUrl: string;
  setLogoUrl: (value: string) => void;
  showToast: (message: string) => void;
}) {
  const [name, setName] = useState("Live Event");

  const createEvent = async (event: FormEvent) => {
    event.preventDefault();
    const data = await createFirebaseEvent({
      name,
      question: DEFAULT_POLL_QUESTION,
      options: DEFAULT_POLL_OPTIONS
    });
    window.location.href = `/admin/${data.id}`;
  };

  return (
    <Shell>
      <section className="grid grid-2">
        <form className="panel panel-pad grid" onSubmit={createEvent}>
          <div className="grid" style={{ gap: 8 }}>
            <h1>Create Event</h1>
            <p className="muted">Make a session, show the QR, and collect live reactions.</p>
          </div>
          <div className="field">
            <label htmlFor="event-name">Event name</label>
            <input className="input" id="event-name" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="actions">
            <button className="button green" type="submit">
              Create Event
            </button>
          </div>
        </form>
        <aside className="grid">
          <LogoUpload logoUrl={logoUrl} setLogoUrl={setLogoUrl} showToast={showToast} />
        </aside>
      </section>
    </Shell>
  );
}

function AdminEvent({
  eventState,
  links,
  logoUrl,
  setLogoUrl,
  showToast
}: {
  eventState: EventState;
  links: EventLinks;
  logoUrl: string;
  setLogoUrl: (value: string) => void;
  showToast: (message: string) => void;
}) {
  const [selectedQuestionId, setSelectedQuestionId] = useState(eventState.activeQuestionId);
  const selectedQuestion =
    eventState.questions.find((questionItem) => questionItem.id === selectedQuestionId) || eventState.poll;
  const isSelectedLive = selectedQuestion.id === eventState.activeQuestionId;
  const [question, setQuestion] = useState(selectedQuestion.question);
  const [options, setOptions] = useState(selectedQuestion.options.map((option) => option.text));
  const [isDeleting, setIsDeleting] = useState(false);
  const [isDeletingQuestion, setIsDeletingQuestion] = useState(false);

  useEffect(() => {
    if (!eventState.questions.some((questionItem) => questionItem.id === selectedQuestionId)) {
      setSelectedQuestionId(eventState.activeQuestionId);
    }
  }, [eventState.activeQuestionId, eventState.questions, selectedQuestionId]);

  useEffect(() => {
    setQuestion(selectedQuestion.question);
    setOptions(selectedQuestion.options.map((option) => option.text));
  }, [
    selectedQuestion.id,
    selectedQuestion.question,
    selectedQuestion.options.map((option) => `${option.id}:${option.text}`).join("|")
  ]);

  const updateOption = (index: number, value: string) => {
    setOptions((current) => current.map((option, optionIndex) => (optionIndex === index ? value : option)));
  };

  const removeOption = (index: number) => {
    setOptions((current) => (current.length <= 2 ? current : current.filter((_, optionIndex) => optionIndex !== index)));
  };

  const updatePoll = async (event: FormEvent) => {
    event.preventDefault();
    const cleanOptions = options.map((option) => option.trim()).filter(Boolean);
    if (cleanOptions.length < 2) {
      showToast("Add at least two poll options");
      return;
    }
    await updateFirebasePoll(eventState.id, {
      questionId: selectedQuestion.id,
      question,
      options: cleanOptions,
      active: isSelectedLive
    });
    showToast(isSelectedLive ? "Live question saved" : "Question saved");
  };

  const addQuestion = async () => {
    const questionId = await addFirebaseQuestion(eventState.id, {
      question: DEFAULT_POLL_QUESTION,
      options: DEFAULT_POLL_OPTIONS,
      active: false
    });
    setSelectedQuestionId(questionId);
    showToast("Question added");
  };

  const makeQuestionLive = async () => {
    await activateFirebaseQuestion(eventState.id, selectedQuestion.id);
    showToast("Question is live");
  };

  const deleteQuestion = async () => {
    if (eventState.questions.length <= 1) {
      showToast("Keep at least one question");
      return;
    }

    const confirmed = window.confirm(
      `Delete this question?\n\n"${selectedQuestion.question}"\n\nVotes for this question will also be removed.`
    );
    if (!confirmed) return;

    const remainingQuestions = eventState.questions.filter((questionItem) => questionItem.id !== selectedQuestion.id);
    setIsDeletingQuestion(true);
    try {
      await deleteFirebaseQuestion(eventState.id, selectedQuestion.id);
      setSelectedQuestionId(isSelectedLive ? remainingQuestions[0].id : eventState.activeQuestionId);
      showToast(isSelectedLive ? "Question deleted; another question is live" : "Question deleted");
    } catch (error) {
      showToast((error as Error).message || "Could not delete question");
    } finally {
      setIsDeletingQuestion(false);
    }
  };

  const resetEvent = async () => {
    await resetFirebaseEvent(eventState.id);
    showToast("Live data reset");
  };

  const deleteEvent = async () => {
    const confirmed = window.confirm(
      `Delete "${eventState.name}"?\n\nThis removes the event, votes, messages, and reactions. This cannot be undone.`
    );
    if (!confirmed) return;
    setIsDeleting(true);
    try {
      await deleteFirebaseEvent(eventState.id);
      window.location.href = "/";
    } catch (error) {
      setIsDeleting(false);
      showToast((error as Error).message || "Could not delete event");
    }
  };

  const copy = async (value: string) => {
    await navigator.clipboard.writeText(value);
    showToast("Copied");
  };

  return (
    <Shell eventId={eventState.id}>
      <section className="grid grid-2">
        <div className="grid">
          <div className="panel panel-pad grid">
            <div className="grid" style={{ gap: 8 }}>
              <h1>{eventState.name}</h1>
              <p className="muted">Event code: {eventState.id}</p>
            </div>
            <div className="grid grid-3">
              <Stat label="Live Votes" value={eventState.poll.totalVotes} />
              <Stat label="Messages" value={eventState.stats.messages} />
              <Stat label="Reactions" value={reactionCount(eventState.stats)} />
            </div>
            <div className="actions">
              <a className="button" href={links.displayUrl} target="_blank" rel="noreferrer">
                Display Screen
              </a>
              <a className="button secondary" href={links.audienceUrl} target="_blank" rel="noreferrer">
                Audience Phone
              </a>
              <button className="button red" type="button" onClick={resetEvent}>
                Reset Live Data
              </button>
              <button className="button red" type="button" onClick={deleteEvent} disabled={isDeleting}>
                {isDeleting ? "Deleting..." : "Delete Event"}
              </button>
            </div>
          </div>

          <section className="panel panel-pad grid">
            <div className="section-head">
              <div>
                <h2>Questions</h2>
                <p className="muted">Add questions here, then choose which one is live.</p>
              </div>
              <button type="button" className="button secondary" onClick={addQuestion}>
                Add Question
              </button>
            </div>
            <div className="question-list">
              {eventState.questions.map((questionItem, index) => (
                <button
                  key={questionItem.id}
                  className={`question-item ${questionItem.id === selectedQuestion.id ? "selected" : ""} ${
                    questionItem.id === eventState.activeQuestionId ? "live" : ""
                  }`}
                  type="button"
                  onClick={() => setSelectedQuestionId(questionItem.id)}
                >
                  <span className="question-index">Q{index + 1}</span>
                  <strong>{questionItem.question}</strong>
                  <small>{questionItem.id === eventState.activeQuestionId ? "Live now" : `${questionItem.totalVotes} votes`}</small>
                </button>
              ))}
            </div>
          </section>

          <form className="panel panel-pad grid" onSubmit={updatePoll}>
            <div className="grid" style={{ gap: 8 }}>
              <h2>{isSelectedLive ? "Live Question" : "Edit Question"}</h2>
              <p className="muted">
                {selectedQuestion.totalVotes
                  ? "Saving text or options resets votes for this question."
                  : "Changes save to this question only."}
              </p>
            </div>
            <div className="field">
              <label htmlFor="edit-question">Poll question</label>
              <input className="input" id="edit-question" value={question} maxLength={120} onChange={(event) => setQuestion(event.target.value)} />
            </div>
            <div className="field">
              <span className="small-label">Poll options</span>
              <div className="grid">
                {options.map((option, index) => (
                  <OptionInput
                    key={index}
                    value={option}
                    onChange={(value) => updateOption(index, value)}
                    onRemove={() => removeOption(index)}
                  />
                ))}
              </div>
            </div>
            <div className="actions">
              <button type="button" className="button secondary" onClick={() => setOptions((current) => [...current, ""])}>
                Add Option
              </button>
              {!isSelectedLive && (
                <button type="button" className="button" onClick={makeQuestionLive}>
                  Make Live
                </button>
              )}
              <button
                type="button"
                className="button red"
                onClick={deleteQuestion}
                disabled={isDeletingQuestion || eventState.questions.length <= 1}
              >
                {isDeletingQuestion ? "Deleting..." : "Delete Question"}
              </button>
              <button className="button green" type="submit">
                Save Question
              </button>
            </div>
          </form>
        </div>

        <aside className="grid">
          <LogoUpload logoUrl={logoUrl} setLogoUrl={setLogoUrl} showToast={showToast} />
          <div className="panel qr-card">
            <img src={links.qr} alt="Audience QR code" />
            <div>
              <h3>Audience QR</h3>
              <p className="muted">Scan to join</p>
            </div>
          </div>
          <div className="panel panel-pad link-box">
            <CopyLine label="Audience" value={links.audienceUrl} onCopy={copy} />
            <CopyLine label="Display" value={links.displayUrl} onCopy={copy} />
            <CopyLine label="Admin" value={links.adminUrl} onCopy={copy} />
          </div>
          <div className="panel panel-pad grid">
            <h2>Live Results</h2>
            <PollBars poll={eventState.poll} />
          </div>
        </aside>
      </section>
    </Shell>
  );
}

function Stat({ label, value, detail }: { label: string; value: string | number; detail?: string }) {
  return (
    <div className="stat">
      <span className="muted">{label}</span>
      <strong>{value}</strong>
      {detail && <span>{detail}</span>}
    </div>
  );
}

function CopyLine({ label, value, onCopy }: { label: string; value: string; onCopy: (value: string) => void }) {
  return (
    <div className="copy-line">
      <code>
        {label}: {value}
      </code>
      <button className="button secondary" type="button" onClick={() => onCopy(value)}>
        Copy
      </button>
    </div>
  );
}

function Audience({
  eventState,
  clientId,
  logoUrl,
  showToast
}: {
  eventState: EventState;
  clientId: string;
  logoUrl: string;
  showToast: (message: string) => void;
}) {
  const [activeTab, setActiveTab] = useState<"chat" | "poll">("chat");
  const [message, setMessage] = useState("");
  const [selectedVote, setSelectedVoteState] = useState(() => getSelectedVote(eventState.id, eventState.poll.id));
  const messageInputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setSelectedVoteState(getSelectedVote(eventState.id, eventState.poll.id));
  }, [eventState.id, eventState.poll.id]);

  const sendMessage = () => {
    const text = message.trim();
    if (!text) {
      messageInputRef.current?.focus({ preventScroll: true });
      return;
    }
    sendFirebaseMessage(eventState.id, clientId, text).catch((error) => showToast((error as Error).message));
    setMessage("");
    showToast("Sent");
    messageInputRef.current?.focus({ preventScroll: true });
  };

  const handleSendPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    sendMessage();
  };

  const sendReaction = (emoji: string) => {
    sendFirebaseReaction(eventState.id, clientId, emoji).catch((error) => showToast((error as Error).message));
  };

  const vote = (optionId: string) => {
    setSelectedVote(eventState.id, eventState.poll.id, optionId);
    setSelectedVoteState(optionId);
    voteFirebase(eventState.id, clientId, eventState.poll.id, optionId).catch((error) => showToast((error as Error).message));
    showToast("Vote sent");
  };

  return (
    <main className="phone-shell">
      <section className="phone-card">
        <header className="phone-header">
          <img className="phone-logo" src={logoUrl} alt="Event logo" />
          <h2>{eventState.name}</h2>
        </header>
        <nav className="tabs">
          <button className={`tab ${activeTab === "chat" ? "active" : ""}`} type="button" onClick={() => setActiveTab("chat")}>
            Chat
          </button>
          <button className={`tab ${activeTab === "poll" ? "active" : ""}`} type="button" onClick={() => setActiveTab("poll")}>
            Poll
          </button>
        </nav>
        <div className="phone-body">
          {activeTab === "chat" ? (
            <div className="chat-compose">
              <div className="field">
                <label htmlFor="message">Message</label>
                <textarea
                  className="textarea"
                  id="message"
                  ref={messageInputRef}
                  maxLength={90}
                  placeholder="Type something"
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      sendMessage();
                    }
                  }}
                />
              </div>
              <button
                className="button green"
                type="button"
                onPointerDown={handleSendPointerDown}
                onClick={(event) => {
                  if (event.detail === 0) sendMessage();
                }}
              >
                Send Message
              </button>
              <div className="reaction-grid">
                {REACTIONS.map((reaction) => (
                  <button
                    key={reaction.label}
                    className="reaction-button"
                    type="button"
                    title={reaction.label}
                    aria-label={`${reaction.label} reaction`}
                    onClick={() => sendReaction(reaction.emoji)}
                  >
                    <span>{reaction.emoji}</span>
                    <small>{reaction.label}</small>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="grid" style={{ gap: 12 }}>
              <h2>{eventState.poll.question}</h2>
              <div className="vote-list">
                {eventState.poll.options.map((option) => (
                  <button
                    key={option.id}
                    className={`vote-option ${selectedVote === option.id ? "selected" : ""}`}
                    type="button"
                    onClick={() => vote(option.id)}
                  >
                    <span>{option.text}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

function Display({
  eventState,
  links: _links,
  logoUrl,
  messages,
  reactions
}: {
  eventState: EventState;
  links: EventLinks;
  logoUrl: string;
  messages: DisplayMessage[];
  reactions: FloatingReaction[];
}) {
  return (
    <main className="display">
      <div className="reaction-layer">
        {reactions.map((reaction) => (
          <span
            key={reaction.id}
            className="reaction-float"
            style={
              {
                "--x": `${reaction.x}%`,
                "--drift": `${reaction.drift}px`,
                "--spin": `${reaction.spin}deg`
              } as CSSProperties
            }
          >
            {reaction.emoji}
          </span>
        ))}
      </div>
      <section className="display-main">
        <img className="menti-logo" src={logoUrl} alt="Event logo" />
        <section className="menti-layout">
          <section className="menti-results">
            <h1>{eventState.poll.question}</h1>
            <MentiBars poll={eventState.poll} />
          </section>
        </section>
        <aside className={`feed-side ${messages.length ? "" : "empty"}`}>
          {messages.map((message, index) => (
            <ChatMessage key={message.id} message={message} index={index} />
          ))}
        </aside>
      </section>
    </main>
  );
}

function MentiBars({ poll }: { poll: Poll }) {
  const maxVotes = Math.max(1, ...poll.options.map((option) => option.votes));

  return (
    <div className="menti-bars">
      {poll.options.map((option, index) => {
        const width = option.votes > 0 ? Math.max(2, Math.round((option.votes / maxVotes) * 100)) : 0;
        return (
          <div className="menti-row" key={option.id}>
            <div className="menti-count">{option.votes}</div>
            <div className="menti-track-wrap">
              <div className="menti-label">{option.text}</div>
              <div className="menti-track">
                <div className="menti-fill" style={{ width: `${width}%`, background: mentiColor(index) }} />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function mentiColor(index: number) {
  const colors = ["#ff6b6b", "#6574ff", "#374785", "#a5a6ff", "#12b76a", "#fdb022"];
  return colors[index % colors.length];
}

function ChatMessage({ message, index }: { message: DisplayMessage; index: number }) {
  const remaining = Math.max(1200, message.expiresAt - Date.now());
  return (
    <article
      className="chat-message"
      style={
        {
          "--delay": `${index * 45}ms`,
          "--life": `${remaining}ms`
        } as CSSProperties
      }
    >
      {message.text}
    </article>
  );
}

function PollBars({ poll }: { poll: Poll }) {
  if (!poll.options.length) {
    return <div className="empty-state">No options</div>;
  }
  return (
    <div className="poll-bars">
      {poll.options.map((option, index) => (
        <div className="result-row" key={option.id}>
          <div className="result-top">
            <span>{option.text}</span>
            <span>
              {option.votes} &middot; {option.percentage}%
            </span>
          </div>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${option.percentage}%`, background: barColor(index) }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export default App;
