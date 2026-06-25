export type StoreUnsubscribe = () => void;

export type StoreSubscriber<T> = (snapshot: T) => void;

export interface Store<T> {
  get(): T;
  set(next: T): void;
  subscribe(fn: StoreSubscriber<T>): StoreUnsubscribe;
}

export function store<T>(initial: T): Store<T> {
  let snapshot = initial;
  const subscribers = new Set<StoreSubscriber<T>>();

  return Object.freeze({
    get(): T {
      return snapshot;
    },

    set(next: T): void {
      if (Object.is(snapshot, next)) return;

      snapshot = next;

      const pending = [...subscribers];

      for (let index = 0; index < pending.length; index += 1) {
        const subscriber = pending[index];

        if (subscriber !== undefined && subscribers.has(subscriber)) {
          subscriber(snapshot);
        }
      }
    },

    subscribe(fn: StoreSubscriber<T>): StoreUnsubscribe {
      subscribers.add(fn);

      return () => {
        subscribers.delete(fn);
      };
    },
  });
}
