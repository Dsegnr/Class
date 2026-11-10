export interface Person {
  student_id: string;
  name: string;
}
export interface User extends Person {
  role: "student" | "admin";
  must_change: boolean;
  csrf: string;
}
export interface Task {
  id: string;
  title: string;
  description: string;
  state: "draft" | "published" | "closed" | "archived";
  deadline: number | null;
  targets: string[];
  max_files: number;
  max_bytes: number;
  allow_late: boolean;
  review_required: boolean;
  extensions: string[];
  created: number;
  my_status?: string;
  submitted_count?: number;
}
export interface Attachment {
  id: string;
  name: string;
  size: number;
  extension: string;
  sha256: string;
}
export interface Submission {
  id: string;
  task_id: string;
  student_id: string;
  status: "draft" | "submitted" | "returned" | "approved" | "withdrawn";
  note: string;
  created: number;
  submitted: number | null;
  files: Attachment[];
}
export interface StatusRow extends Person {
  status: string;
  submission_id: string | null;
}
export interface Notice {
  id: string;
  title: string;
  body: string;
  read: boolean;
  created: number;
}
export interface EventRecord {
  id: string;
  kind: string;
  created: number;
  payload: {
    winners?: Person[];
    pool?: Person[];
    members?: Person[];
    count?: number;
    source?: string;
    reason?: string;
    date?: string;
    excluded?: string[];
    selected?: string[];
    before?: Person[];
    base_members?: Person[];
    replacements?: DutyReplacement[];
  };
}
export interface DrawState {
  pool_version: string;
  eligible: Person[];
  excluded: string[];
  selected: string[];
  algorithm: string;
  events: EventRecord[];
}
export interface DutyState {
  next_index: number;
  date: string | null;
  next: Person[];
  order: Person[];
  exempt: Person[];
  events: EventRecord[];
  base_next: Person[];
  plan_version: string;
  replacements: DutyReplacement[];
  reason: string;
  plan_events: EventRecord[];
}
export interface DutyReplacement {
  original_id: string;
  substitute_id: string;
}
