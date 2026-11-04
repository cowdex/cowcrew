export type ToastKind = 'error' | 'success' | 'info';
export interface Toast { id: number; kind: ToastKind; text: string }
type Listener = (toasts: Toast[]) => void;

let toasts: Toast[] = [];
let seq = 1;
const listeners = new Set<Listener>();

function emit() {
  listeners.forEach((l) => l(toasts));
}

export function pushToast(kind: ToastKind, text: string, ttl = 5000) {
  const id = seq++;
  // de-duplicate identical messages already on screen
  if (toasts.some((t) => t.text === text && t.kind === kind)) return;
  toasts = [...toasts, { id, kind, text }].slice(-4);
  emit();
  window.setTimeout(() => dismissToast(id), ttl);
}

export function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export function subscribeToasts(l: Listener): () => void {
  listeners.add(l);
  l(toasts);
  return () => {
    listeners.delete(l);
  };
}

export const toast = {
  error: (t: string) => pushToast('error', t, 7000),
  success: (t: string) => pushToast('success', t),
  info: (t: string) => pushToast('info', t),
};
