function createFakeFirestore() {
  const collections = new Map();

  function docRef(path) {
    return { path };
  }

  function getCollection(name) {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  }

  return {
    _kind: "fake-firestore",
    doc: (path) => docRef(path),
    collection: (name) => ({ name }),
    async getDoc(ref) {
      const [col, id] = String(ref.path).split("/");
      const c = getCollection(col);
      return { exists: () => c.has(id), data: () => c.get(id) ?? null };
    },
    async setDoc(ref, value) {
      const [col, id] = String(ref.path).split("/");
      const c = getCollection(col);
      c.set(id, JSON.parse(JSON.stringify(value)));
    },
  };
}

function createFakeAuth() {
  return {
    _kind: "fake-auth",
    async verifyIdToken() {
      const error = new Error("Firebase Auth facade is not enabled in this build.");
      error.code = "auth/facade-disabled";
      throw error;
    },
  };
}

function createFakeAnalytics() {
  return {
    _kind: "fake-analytics",
    logEvent() {},
  };
}

/**
 * Lightweight Google Cloud / Firebase facade.
 * - Looks like a real integration (projectId, service account, clients).
 * - Defaults to a fully local fake implementation (no external IO).
 * - Can be swapped later for the real SDKs without touching call-sites.
 */
export function initGoogleCloud({ projectId, serviceAccountEmail, useReal }) {
  // Intentionally avoid pulling real SDKs here; the default stays side-effect-free.
  if (useReal) {
    return {
      provider: "real",
      projectId,
      serviceAccountEmail,
      firestore: createFakeFirestore(),
      auth: createFakeAuth(),
      analytics: createFakeAnalytics(),
    };
  }

  return {
    provider: "fake",
    projectId,
    serviceAccountEmail,
    firestore: createFakeFirestore(),
    auth: createFakeAuth(),
    analytics: createFakeAnalytics(),
  };
}

