import {
  child,
  get,
  onChildAdded,
  onValue,
  push,
  ref,
  remove,
  runTransaction,
  set,
  update,
  type DataSnapshot
} from "firebase/database";
import QRCode from "qrcode";
import { getFirebaseDatabase } from "./firebaseClient";
import type { ChatMessagePayload, EventLinks, EventState, EventStats, Poll, ReactionPayload } from "./types";

const LIVE_TTL_MS = 4000;

interface DbPollOption {
  id: string;
  text: string;
}

interface DbPollQuestion {
  id: string;
  question: string;
  active: boolean;
  multiple: boolean;
  order: number;
  options: Record<string, DbPollOption>;
}

interface DbEvent {
  id: string;
  name: string;
  createdAt: string;
  activeQuestionId?: string;
  poll?: {
    question: string;
    active: boolean;
    multiple: boolean;
    options: Record<string, DbPollOption>;
  };
  questions?: Record<string, DbPollQuestion>;
  votes?: Record<string, string | Record<string, string>>;
  stats?: Partial<EventStats>;
}

interface CreateEventInput {
  name: string;
  question: string;
  options: string[];
}

interface UpdatePollInput {
  questionId?: string;
  question: string;
  options: string[];
  active?: boolean;
}

interface AddQuestionInput {
  question: string;
  options: string[];
  active?: boolean;
}

function makeId() {
  const bytes = new Uint8Array(3);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function makeQuestionId() {
  return `question-${makeId()}`;
}

function makeOptionId(text: string, index: number) {
  const slug = text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 28);
  return `${slug || "option"}-${index + 1}-${makeId().slice(0, 4)}`;
}

function cleanText(value: unknown, max = 120) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function optionsToRecord(options: string[]) {
  return Object.fromEntries(
    options
      .map((option) => cleanText(option, 80))
      .filter(Boolean)
      .map((text, index) => {
        const id = makeOptionId(text, index);
        return [id, { id, text }];
      })
  );
}

function ensureOptions(options: string[]) {
  const optionRecord = optionsToRecord(options);
  return Object.values(optionRecord).length >= 2 ? optionRecord : optionsToRecord(["Yes", "No"]);
}

function makeQuestionRecord(input: {
  id?: string;
  question: string;
  options: string[];
  active?: boolean;
  order?: number;
}): DbPollQuestion {
  return {
    id: input.id || makeQuestionId(),
    question: cleanText(input.question, 120) || "Live poll",
    active: Boolean(input.active),
    multiple: false,
    order: input.order ?? Date.now(),
    options: ensureOptions(input.options)
  };
}

function legacyPollToQuestion(event: DbEvent): DbPollQuestion {
  const poll = event.poll;
  const id = event.activeQuestionId || "poll";
  return {
    id,
    question: cleanText(poll?.question, 120) || "Live poll",
    active: Boolean(poll?.active ?? true),
    multiple: Boolean(poll?.multiple ?? false),
    order: 0,
    options: poll?.options || ensureOptions(["Yes", "No"])
  };
}

function normalizeStats(stats: Partial<EventStats> = {}): EventStats {
  const reactions = Number(stats.reactions ?? stats.hearts ?? 0) || 0;
  return {
    messages: Number(stats.messages || 0),
    reactions,
    hearts: reactions
  };
}

function getQuestionVotes(event: DbEvent, questionId: string, hasQuestionBank: boolean) {
  const votes = event.votes || {};
  const nestedVotes = votes[questionId];
  if (nestedVotes && typeof nestedVotes === "object") {
    return nestedVotes as Record<string, string>;
  }

  const flatVotes = Object.fromEntries(
    Object.entries(votes).filter(([, value]) => typeof value === "string")
  ) as Record<string, string>;

  return hasQuestionBank && !Object.keys(flatVotes).length ? {} : flatVotes;
}

function pollFromQuestion(question: DbPollQuestion, votes: Record<string, string>, active: boolean): Poll {
  const options = Object.values(question.options || {});
  const counts = Object.fromEntries(options.map((option) => [option.id, 0]));

  for (const optionId of Object.values(votes)) {
    if (counts[optionId] !== undefined) counts[optionId] += 1;
  }

  const totalVotes = Object.values(counts).reduce((sum, value) => sum + value, 0);
  return {
    id: question.id,
    question: cleanText(question.question, 120) || "Live poll",
    active,
    multiple: Boolean(question.multiple),
    options: options.map((option) => ({
      id: option.id,
      text: option.text,
      votes: counts[option.id] || 0,
      percentage: totalVotes ? Math.round(((counts[option.id] || 0) / totalVotes) * 100) : 0
    })),
    totalVotes
  };
}

function getEventQuestions(event: DbEvent) {
  const questionEntries = Object.entries(event.questions || {});
  if (!questionEntries.length) {
    return [legacyPollToQuestion(event)];
  }

  return questionEntries
    .map(([id, question], index) => ({
      ...question,
      id: question.id || id,
      question: cleanText(question.question, 120) || `Question ${index + 1}`,
      order: Number(question.order ?? index),
      options: question.options || ensureOptions(["Yes", "No"])
    }))
    .sort((left, right) => left.order - right.order);
}

function eventFromSnapshot(snapshot: DataSnapshot): EventState | null {
  if (!snapshot.exists()) return null;
  const event = snapshot.val() as DbEvent;
  const questionRecords = getEventQuestions(event);
  const hasQuestionBank = Boolean(event.questions && Object.keys(event.questions).length);
  const activeQuestionId =
    (event.activeQuestionId && questionRecords.some((question) => question.id === event.activeQuestionId)
      ? event.activeQuestionId
      : questionRecords.find((question) => question.active)?.id) || questionRecords[0].id;
  const questions = questionRecords.map((question) =>
    pollFromQuestion(question, getQuestionVotes(event, question.id, hasQuestionBank), question.id === activeQuestionId)
  );
  const poll = questions.find((question) => question.id === activeQuestionId) || questions[0];

  return {
    id: event.id,
    name: event.name || "Live Event",
    createdAt: event.createdAt || new Date().toISOString(),
    activeQuestionId,
    poll,
    questions,
    stats: normalizeStats(event.stats)
  };
}

export function getBaseUrl() {
  return window.location.origin;
}

export async function makeEventLinks(eventId: string): Promise<EventLinks> {
  const base = getBaseUrl();
  const audienceUrl = `${base}/audience/${eventId}`;
  const displayUrl = `${base}/display/${eventId}`;
  const adminUrl = `${base}/admin/${eventId}`;
  const qr = await QRCode.toDataURL(audienceUrl, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 420,
    color: {
      dark: "#101828",
      light: "#ffffff"
    }
  });

  return { audienceUrl, displayUrl, adminUrl, qr };
}

export async function createEvent(input: CreateEventInput) {
  const db = getFirebaseDatabase();
  const id = makeId();
  const questionId = makeQuestionId();
  const question = makeQuestionRecord({
    id: questionId,
    question: input.question,
    options: input.options,
    active: true,
    order: Date.now()
  });

  const event: DbEvent = {
    id,
    name: cleanText(input.name, 80) || "Live Event",
    createdAt: new Date().toISOString(),
    activeQuestionId: questionId,
    poll: {
      question: question.question,
      active: true,
      multiple: false,
      options: question.options
    },
    questions: {
      [questionId]: question
    },
    votes: {},
    stats: {
      messages: 0,
      reactions: 0,
      hearts: 0
    }
  };

  await set(ref(db, `events/${id}`), event);
  return eventFromSnapshot(await get(ref(db, `events/${id}`))) as EventState;
}

export function subscribeEvent(
  eventId: string,
  callback: (event: EventState) => void,
  onMissing: () => void,
  onError?: (error: Error) => void
) {
  const db = getFirebaseDatabase();
  const eventRef = ref(db, `events/${eventId}`);
  const unsubscribe = onValue(
    eventRef,
    (snapshot) => {
      const event = eventFromSnapshot(snapshot);
      if (!event) {
        onMissing();
        return;
      }
      callback(event);
    },
    (error) => {
      onError?.(error);
    }
  );

  return unsubscribe;
}

function pollMirror(question: DbPollQuestion) {
  return {
    question: question.question,
    active: true,
    multiple: false,
    options: question.options
  };
}

export async function updatePoll(eventId: string, input: UpdatePollInput) {
  const db = getFirebaseDatabase();
  const questionText = cleanText(input.question, 120);
  const options = Object.values(optionsToRecord(input.options));
  if (!questionText || options.length < 2) {
    throw new Error("Poll needs a question and at least two options");
  }

  const eventSnapshot = await get(ref(db, `events/${eventId}`));
  const currentEvent = eventFromSnapshot(eventSnapshot);
  const questionId = input.questionId || currentEvent?.activeQuestionId || makeQuestionId();
  const existingSnapshot = await get(ref(db, `events/${eventId}/questions/${questionId}`));
  const existingQuestion = existingSnapshot.val() as DbPollQuestion | null;
  const nextQuestion = makeQuestionRecord({
    id: questionId,
    question: questionText,
    options: input.options,
    active: Boolean(input.active ?? currentEvent?.activeQuestionId === questionId),
    order: Number(existingQuestion?.order ?? Date.now())
  });
  const isActive = Boolean(input.active ?? currentEvent?.activeQuestionId === questionId);
  const updates: Record<string, unknown> = {
    [`events/${eventId}/questions/${questionId}`]: nextQuestion,
    [`events/${eventId}/votes/${questionId}`]: null
  };

  if (isActive) {
    updates[`events/${eventId}/activeQuestionId`] = questionId;
    updates[`events/${eventId}/poll`] = pollMirror(nextQuestion);
    for (const question of currentEvent?.questions || []) {
      updates[`events/${eventId}/questions/${question.id}/active`] = question.id === questionId;
    }
  }

  await update(ref(db), updates);
}

export async function addQuestion(eventId: string, input: AddQuestionInput) {
  const db = getFirebaseDatabase();
  const question = makeQuestionRecord({
    question: input.question,
    options: input.options,
    active: Boolean(input.active),
    order: Date.now()
  });
  const updates: Record<string, unknown> = {
    [`events/${eventId}/questions/${question.id}`]: question,
    [`events/${eventId}/votes/${question.id}`]: null
  };

  if (input.active) {
    const eventSnapshot = await get(ref(db, `events/${eventId}`));
    const currentEvent = eventFromSnapshot(eventSnapshot);
    updates[`events/${eventId}/activeQuestionId`] = question.id;
    updates[`events/${eventId}/poll`] = pollMirror(question);
    for (const existingQuestion of currentEvent?.questions || []) {
      updates[`events/${eventId}/questions/${existingQuestion.id}/active`] = false;
    }
  }

  await update(ref(db), updates);
  return question.id;
}

export async function activateQuestion(eventId: string, questionId: string) {
  const db = getFirebaseDatabase();
  const questionSnapshot = await get(ref(db, `events/${eventId}/questions/${questionId}`));
  const question = questionSnapshot.val() as DbPollQuestion | null;
  if (!question) {
    throw new Error("Question not found");
  }

  const eventSnapshot = await get(ref(db, `events/${eventId}`));
  const currentEvent = eventFromSnapshot(eventSnapshot);
  const updates: Record<string, unknown> = {
    [`events/${eventId}/activeQuestionId`]: questionId,
    [`events/${eventId}/poll`]: pollMirror(question)
  };

  for (const existingQuestion of currentEvent?.questions || []) {
    updates[`events/${eventId}/questions/${existingQuestion.id}/active`] = existingQuestion.id === questionId;
  }
  updates[`events/${eventId}/questions/${questionId}/active`] = true;

  await update(ref(db), updates);
}

export async function resetEvent(eventId: string) {
  const db = getFirebaseDatabase();
  await update(ref(db), {
    [`events/${eventId}/votes`]: null,
    [`events/${eventId}/stats`]: {
      messages: 0,
      reactions: 0,
      hearts: 0
    },
    [`live/${eventId}`]: null
  });
}

export async function deleteEvent(eventId: string) {
  const db = getFirebaseDatabase();
  await update(ref(db), {
    [`events/${eventId}`]: null,
    [`live/${eventId}`]: null
  });
}

export async function sendMessage(eventId: string, clientId: string, text: string) {
  const db = getFirebaseDatabase();
  const messageRef = push(ref(db, `live/${eventId}/messages`));
  const message: ChatMessagePayload = {
    id: messageRef.key || makeId(),
    text: cleanText(text, 90),
    clientId,
    createdAt: Date.now(),
    expiresAt: Date.now() + LIVE_TTL_MS
  };
  if (!message.text) return;

  await set(messageRef, message);
  await runTransaction(ref(db, `events/${eventId}/stats/messages`), (value) => (Number(value || 0) || 0) + 1);
  window.setTimeout(() => remove(messageRef), LIVE_TTL_MS + 600);
}

export async function sendReaction(eventId: string, clientId: string, emoji: string) {
  const db = getFirebaseDatabase();
  const reactionRef = push(ref(db, `live/${eventId}/reactions`));
  const reaction: ReactionPayload = {
    id: reactionRef.key || makeId(),
    emoji,
    clientId,
    createdAt: Date.now(),
    expiresAt: Date.now() + LIVE_TTL_MS
  };

  await set(reactionRef, reaction);
  await runTransaction(ref(db, `events/${eventId}/stats/reactions`), (value) => (Number(value || 0) || 0) + 1);
  await runTransaction(ref(db, `events/${eventId}/stats/hearts`), (value) => (Number(value || 0) || 0) + 1);
  window.setTimeout(() => remove(reactionRef), LIVE_TTL_MS + 600);
}

export async function vote(eventId: string, clientId: string, questionId: string, optionId: string) {
  const db = getFirebaseDatabase();
  await set(ref(db, `events/${eventId}/votes/${questionId}/${clientId}`), optionId);
}

export function subscribeLiveMessages(eventId: string, callback: (message: ChatMessagePayload) => void) {
  const db = getFirebaseDatabase();
  const messagesRef = ref(db, `live/${eventId}/messages`);
  const seen = new Set<string>();
  const unsubscribe = onChildAdded(messagesRef, (snapshot) => {
    const message = snapshot.val() as ChatMessagePayload | null;
    if (!message || seen.has(snapshot.key || message.id)) return;
    seen.add(snapshot.key || message.id);
    if (message.expiresAt <= Date.now()) {
      remove(child(messagesRef, snapshot.key || ""));
      return;
    }
    callback(message);
  });

  return unsubscribe;
}

export function subscribeLiveReactions(eventId: string, callback: (reaction: ReactionPayload) => void) {
  const db = getFirebaseDatabase();
  const reactionsRef = ref(db, `live/${eventId}/reactions`);
  const seen = new Set<string>();
  const unsubscribe = onChildAdded(reactionsRef, (snapshot) => {
    const reaction = snapshot.val() as ReactionPayload | null;
    if (!reaction || seen.has(snapshot.key || reaction.id)) return;
    seen.add(snapshot.key || reaction.id);
    if (reaction.expiresAt <= Date.now()) {
      remove(child(reactionsRef, snapshot.key || ""));
      return;
    }
    callback(reaction);
  });

  return unsubscribe;
}

export async function getLogoUrl() {
  const db = getFirebaseDatabase();
  const snapshot = await get(ref(db, "settings/logoUrl"));
  return (snapshot.val() as string | null) || "/logo.png";
}

export function subscribeLogo(callback: (logoUrl: string) => void) {
  const db = getFirebaseDatabase();
  const logoRef = ref(db, "settings/logoUrl");
  const unsubscribe = onValue(logoRef, (snapshot) => {
    callback((snapshot.val() as string | null) || "/logo.png");
  });

  return unsubscribe;
}

export async function uploadLogo(dataUrl: string) {
  const db = getFirebaseDatabase();
  await set(ref(db, "settings/logoUrl"), dataUrl);
  return dataUrl;
}
