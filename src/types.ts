export interface PollOption {
  id: string;
  text: string;
  votes: number;
  percentage: number;
}

export interface Poll {
  id: string;
  question: string;
  active: boolean;
  multiple: boolean;
  options: PollOption[];
  totalVotes: number;
}

export interface EventStats {
  messages: number;
  reactions?: number;
  hearts?: number;
}

export interface EventState {
  id: string;
  name: string;
  createdAt: string;
  activeQuestionId: string;
  poll: Poll;
  questions: Poll[];
  stats: EventStats;
}

export interface EventLinks {
  audienceUrl: string;
  displayUrl: string;
  adminUrl: string;
  qr: string;
}

export interface ChatMessagePayload {
  id: string;
  text: string;
  clientId: string;
  createdAt: number;
  expiresAt: number;
}

export interface ReactionPayload {
  id: string;
  emoji: string;
  clientId: string;
  createdAt: number;
  expiresAt: number;
}
