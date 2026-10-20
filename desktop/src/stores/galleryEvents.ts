/**
 * Admin gallery events — named collections of existing strip/photo IDs.
 * Photos stay in Session/Saved; events only reference them. Deleting an
 * event never deletes photos. Persisted in localStorage.
 */
import { defineStore } from "pinia";
import { computed, ref } from "vue";

const STORAGE_KEY = "nostalgia-gallery-events";
const ACTIVE_KEY = "nostalgia-gallery-active-event";

export interface GalleryEvent {
  id: string;
  name: string;
  description: string;
  /** Optional calendar day for the event (YYYY-MM-DD). */
  date: string;
  /** GalleryPhoto.id values (strip id or disk path). */
  photoIds: string[];
  createdAt: string;
  updatedAt: string;
}

export type GalleryEventInput = {
  name: string;
  description?: string;
  date?: string;
};

function newId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `evt-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function normalizeEvent(raw: Partial<GalleryEvent>): GalleryEvent | null {
  const name = String(raw.name || "").trim();
  if (!name) return null;
  const now = new Date().toISOString();
  const photoIds = Array.isArray(raw.photoIds)
    ? [...new Set(raw.photoIds.map(String).filter(Boolean))]
    : [];
  return {
    id: String(raw.id || newId()),
    name,
    description: String(raw.description || "").trim(),
    date: String(raw.date || "").trim(),
    photoIds,
    createdAt: String(raw.createdAt || now),
    updatedAt: String(raw.updatedAt || now),
  };
}

export const useGalleryEventsStore = defineStore("galleryEvents", () => {
  const events = ref<GalleryEvent[]>([]);
  /** Focused event in the admin gallery (events-first — no All Photos view). */
  const selectedEventId = ref<string | null>(null);
  /**
   * Booth mode: every new capture is attached to this event until
   * stopped. Survives reloads so an event night stays on target.
   */
  const activeEventId = ref<string | null>(null);
  let loaded = false;

  const selectedEvent = computed(() => {
    const id = selectedEventId.value;
    if (!id) return null;
    return events.value.find((e) => e.id === id) ?? null;
  });

  const activeEvent = computed(() => {
    const id = activeEventId.value;
    if (!id) return null;
    return events.value.find((e) => e.id === id) ?? null;
  });

  const sortedEvents = computed(() =>
    [...events.value].sort((a, b) => {
      const ad = a.date || a.createdAt;
      const bd = b.date || b.createdAt;
      if (ad !== bd) return ad < bd ? 1 : -1;
      return a.name.localeCompare(b.name);
    }),
  );

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(events.value));
    } catch (e) {
      console.warn("[GalleryEvents] Persist failed:", e);
    }
  }

  function persistActive() {
    try {
      if (activeEventId.value) {
        localStorage.setItem(ACTIVE_KEY, activeEventId.value);
      } else {
        localStorage.removeItem(ACTIVE_KEY);
      }
    } catch (e) {
      console.warn("[GalleryEvents] Active event persist failed:", e);
    }
  }

  function load() {
    if (loaded) return;
    loaded = true;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          events.value = parsed
            .map((item) => normalizeEvent(item))
            .filter((e): e is GalleryEvent => !!e);
        }
      }
    } catch (e) {
      console.warn("[GalleryEvents] Load failed:", e);
    }
    try {
      const active = localStorage.getItem(ACTIVE_KEY);
      if (active && events.value.some((e) => e.id === active)) {
        activeEventId.value = active;
      } else if (active) {
        localStorage.removeItem(ACTIVE_KEY);
      }
    } catch (e) {
      console.warn("[GalleryEvents] Active event load failed:", e);
    }
  }

  function selectEvent(id: string | null) {
    if (id && !events.value.some((e) => e.id === id)) {
      selectedEventId.value = null;
      return;
    }
    selectedEventId.value = id;
  }

  /** Start booth mode for this event — new captures go here only. */
  function launchEvent(id: string): GalleryEvent | null {
    const event = events.value.find((e) => e.id === id) ?? null;
    if (!event) return null;
    activeEventId.value = event.id;
    selectedEventId.value = event.id;
    persistActive();
    return event;
  }

  function stopActiveEvent() {
    activeEventId.value = null;
    persistActive();
  }

  /** Attach strip/photo ids to the launched event (no-op if none). */
  function attachToActiveEvent(photoIds: string[]) {
    const id = activeEventId.value;
    if (!id || !photoIds.length) return;
    if (!events.value.some((e) => e.id === id)) {
      activeEventId.value = null;
      persistActive();
      return;
    }
    addPhotos(id, photoIds);
  }

  function createEvent(input: GalleryEventInput): GalleryEvent {
    const now = new Date().toISOString();
    const event = normalizeEvent({
      id: newId(),
      name: input.name,
      description: input.description,
      date: input.date,
      photoIds: [],
      createdAt: now,
      updatedAt: now,
    });
    if (!event) throw new Error("Event name is required");
    events.value = [event, ...events.value];
    persist();
    selectedEventId.value = event.id;
    return event;
  }

  function updateEvent(id: string, input: GalleryEventInput): GalleryEvent | null {
    const idx = events.value.findIndex((e) => e.id === id);
    if (idx < 0) return null;
    const prev = events.value[idx]!;
    const next = normalizeEvent({
      ...prev,
      name: input.name,
      description: input.description ?? prev.description,
      date: input.date ?? prev.date,
      updatedAt: new Date().toISOString(),
    });
    if (!next) return null;
    const copy = [...events.value];
    copy[idx] = next;
    events.value = copy;
    persist();
    return next;
  }

  function deleteEvent(id: string) {
    events.value = events.value.filter((e) => e.id !== id);
    if (selectedEventId.value === id) selectedEventId.value = null;
    if (activeEventId.value === id) {
      activeEventId.value = null;
      persistActive();
    }
    persist();
  }

  function addPhotos(eventId: string, photoIds: string[]) {
    const idx = events.value.findIndex((e) => e.id === eventId);
    if (idx < 0) return;
    const prev = events.value[idx]!;
    const merged = [...new Set([...prev.photoIds, ...photoIds.map(String).filter(Boolean)])];
    const copy = [...events.value];
    copy[idx] = {
      ...prev,
      photoIds: merged,
      updatedAt: new Date().toISOString(),
    };
    events.value = copy;
    persist();
  }

  function removePhotos(eventId: string, photoIds: string[]) {
    const idx = events.value.findIndex((e) => e.id === eventId);
    if (idx < 0) return;
    const drop = new Set(photoIds.map(String));
    const prev = events.value[idx]!;
    const copy = [...events.value];
    copy[idx] = {
      ...prev,
      photoIds: prev.photoIds.filter((id) => !drop.has(id)),
      updatedAt: new Date().toISOString(),
    };
    events.value = copy;
    persist();
  }

  function eventIdsForPhoto(photoId: string): string[] {
    return events.value
      .filter((e) => e.photoIds.includes(photoId))
      .map((e) => e.id);
  }

  load();

  return {
    events,
    sortedEvents,
    selectedEventId,
    selectedEvent,
    activeEventId,
    activeEvent,
    load,
    selectEvent,
    launchEvent,
    stopActiveEvent,
    attachToActiveEvent,
    createEvent,
    updateEvent,
    deleteEvent,
    addPhotos,
    removePhotos,
    eventIdsForPhoto,
  };
});
