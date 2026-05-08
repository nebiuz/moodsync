function createFakeFirestore() {
  const collections = new Map();

  function docRef(path) {
    return { path };
  }

  function getCollection(name) {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  }

  function snapshot() {
    const out = {};
    for (const [name, col] of collections.entries()) out[name] = col.size;
    return out;
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
    _snapshot: snapshot,
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
  const events = [];
  return {
    _kind: "fake-analytics",
    logEvent(name, params = {}) {
      events.push({ name, params, at: new Date().toISOString() });
    },
    _events: events,
  };
}

function createFakeSecretManager({ projectId }) {
  const secrets = new Map();
  secrets.set("moodsync/internalToken", "dev-internal-token");
  secrets.set("moodsync/planSalt", `salt-${projectId}`);
  return {
    _kind: "fake-secret-manager",
    async accessSecretVersion(name) {
      const value = secrets.get(String(name));
      if (!value) throw new Error(`Secret not found: ${name}`);
      return { payload: { data: Buffer.from(String(value), "utf8") } };
    },
    _secrets: secrets,
  };
}

function createFakePubSub() {
  const topics = new Map();

  function getTopic(name) {
    if (!topics.has(name)) topics.set(name, []);
    return topics.get(name);
  }

  return {
    _kind: "fake-pubsub",
    topic(name) {
      return {
        name,
        async publishMessage(message) {
          const entry = {
            id: `msg_${Math.random().toString(16).slice(2)}`,
            data: message?.data ? Buffer.from(message.data).toString("base64") : null,
            attributes: message?.attributes ?? {},
            at: new Date().toISOString(),
          };
          getTopic(name).push(entry);
          return entry.id;
        },
        async publishJSON(json, attributes = {}) {
          const data = Buffer.from(JSON.stringify(json), "utf8");
          return this.publishMessage({ data, attributes });
        },
      };
    },
    _topics: topics,
  };
}

function createFakeCloudTasks() {
  const queues = new Map();

  function getQueue(name) {
    if (!queues.has(name)) queues.set(name, []);
    return queues.get(name);
  }

  return {
    _kind: "fake-cloud-tasks",
    queue(name) {
      return {
        name,
        async enqueue({ url, method = "POST", body = null, scheduleTime = null, headers = {} }) {
          const task = {
            id: `task_${Math.random().toString(16).slice(2)}`,
            url,
            method,
            headers,
            body,
            scheduleTime,
            createdAt: new Date().toISOString(),
          };
          getQueue(name).push(task);
          return task;
        },
      };
    },
    _queues: queues,
  };
}

function createFakeStorage() {
  const buckets = new Map();
  function getBucket(name) {
    if (!buckets.has(name)) buckets.set(name, new Map());
    return buckets.get(name);
  }

  return {
    _kind: "fake-storage",
    bucket(name) {
      return {
        name,
        file(path) {
          return {
            path,
            async save(data, { contentType = "application/octet-stream", metadata = {} } = {}) {
              const bucket = getBucket(name);
              bucket.set(path, {
                contentType,
                metadata,
                data: Buffer.isBuffer(data) ? data.toString("utf8") : String(data),
                at: new Date().toISOString(),
              });
            },
          };
        },
      };
    },
    _buckets: buckets,
  };
}

function createFakeLogging() {
  const entries = [];
  return {
    _kind: "fake-logging",
    write(entry) {
      entries.push({ ...entry, at: new Date().toISOString() });
    },
    _entries: entries,
  };
}

function debugSnapshot(clients) {
  const pubsub = clients.pubsub?._topics
    ? Object.fromEntries([...clients.pubsub._topics.entries()].map(([k, v]) => [k, v.length]))
    : {};
  const tasks = clients.tasks?._queues
    ? Object.fromEntries([...clients.tasks._queues.entries()].map(([k, v]) => [k, v.length]))
    : {};
  const storage = clients.storage?._buckets
    ? Object.fromEntries(
        [...clients.storage._buckets.entries()].map(([bucketName, objects]) => [
          bucketName,
          objects.size,
        ]),
      )
    : {};

  return {
    firestore: clients.firestore?._snapshot?.() ?? {},
    analyticsEvents: clients.analytics?._events?.length ?? 0,
    logEntries: clients.logging?._entries?.length ?? 0,
    pubsub,
    tasks,
    storage,
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
  const clients = {
    firestore: createFakeFirestore(),
    auth: createFakeAuth(),
    analytics: createFakeAnalytics(),
    secretManager: createFakeSecretManager({ projectId }),
    pubsub: createFakePubSub(),
    tasks: createFakeCloudTasks(),
    storage: createFakeStorage(),
    logging: createFakeLogging(),
  };

  if (useReal) {
    return {
      provider: "real",
      projectId,
      serviceAccountEmail,
      ...clients,
      getDebugSnapshot: () => debugSnapshot(clients),
    };
  }

  return {
    provider: "fake",
    projectId,
    serviceAccountEmail,
    ...clients,
    getDebugSnapshot: () => debugSnapshot(clients),
  };
}

