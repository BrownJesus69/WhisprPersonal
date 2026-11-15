import { useEffect, useState } from 'react';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { subscribeMyEvents } from '@/lib/firebase/events';
import { useAuthStore } from '@/state/authStore';
import type { EventModel } from '@/types/models';

export function useMyEvents() {
  const uid = useAuthStore(s => s.user?.uid);
  const client = useQueryClient();
  const [fromCache, setFromCache] = useState(false);
  const [error, setError] = useState(false);
  const query = useQuery<EventModel[]>({ queryKey: ['events', uid], enabled: false, queryFn: async () => [] });
  useEffect(() => {
    if (!uid)
      return;
    return subscribeMyEvents(uid, (events, cached) => {
      client.setQueryData(['events', uid], events);
      setFromCache(cached);
      setError(false);
    }, () => setError(true));
  }, [uid, client]);
  return {
    events: query.data ?? [],
    loading: !!uid && !query.data && !error,
    fromCache,
    error
  };
}
