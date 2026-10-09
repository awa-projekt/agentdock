import { useCallback, useEffect, useState } from 'react';
import { api, decideToolCall as decideToolCallApi, respond as respondApi, startDraft as startDraftApi } from './api';
import type { Post, ReviewDecision, ServerEvent, WorkflowEvent } from './types';

/**
 * Owns all run state: the posts map, the per-post raw workflow-event log (for
 * the developer drawer), the live draft text streamed during drafting, and
 * which posts have an active stream. Updates flow in from the SSE feed.
 */
export const useRuns = () => {
  const [postsById, setPostsById] = useState<Record<string, Post>>({});
  const [eventsById, setEventsById] = useState<Record<string, WorkflowEvent[]>>({});
  const [streamingById, setStreamingById] = useState<Record<string, string>>({});
  const [busyById, setBusyById] = useState<Record<string, boolean>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const applyEvent = useCallback((id: string | null, event: ServerEvent) => {
    if (event.type === 'post') {
      setPostsById((prev) => ({ ...prev, [event.post.id]: event.post }));
      setEventsById((prev) => (prev[event.post.id]?.length ? prev : { ...prev, [event.post.id]: event.post.events }));
    } else if (event.type === 'delta' && id) {
      setStreamingById((prev) => ({ ...prev, [id]: (prev[id] ?? '') + event.text }));
    } else if (event.type === 'event' && id) {
      setEventsById((prev) => ({ ...prev, [id]: [...(prev[id] ?? []), event.event] }));
    }
  }, []);

  const refresh = useCallback(async () => {
    const { posts } = await api.listPosts();
    setPostsById(Object.fromEntries(posts.map((p) => [p.id, p])));
    setEventsById((prev) => {
      const next = { ...prev };
      for (const p of posts) if (!next[p.id]?.length) next[p.id] = p.events;
      return next;
    });
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const select = useCallback((id: string | null) => {
    setSelectedId(id);
    if (id) {
      // Hydrate the full event log for a post we only know from the list.
      void api.getPost(id).then(({ post }) => {
        setPostsById((prev) => ({ ...prev, [post.id]: post }));
        setEventsById((prev) => (prev[post.id]?.length ? prev : { ...prev, [post.id]: post.events }));
      });
    }
  }, []);

  const newDraft = useCallback(
    async (brief: string) => {
      let id: string | null = null;
      setStreamingById((prev) => prev);
      await startDraftApi(brief, (event) => {
        if (event.type === 'post' && !id) {
          const postId = event.post.id;
          id = postId;
          setSelectedId(postId);
          setStreamingById((prev) => ({ ...prev, [postId]: '' }));
          setBusyById((prev) => ({ ...prev, [postId]: true }));
        }
        applyEvent(id, event);
      }).finally(() => {
        const startedId = id;
        if (startedId) setBusyById((prev) => ({ ...prev, [startedId]: false }));
      });
    },
    [applyEvent],
  );

  const submitReview = useCallback(
    async (id: string, decision: ReviewDecision) => {
      setBusyById((prev) => ({ ...prev, [id]: true }));
      await respondApi(id, decision, (event) => applyEvent(id, event)).finally(() => {
        setBusyById((prev) => ({ ...prev, [id]: false }));
      });
    },
    [applyEvent],
  );

  const decideToolCall = useCallback(
    async (id: string, accept: boolean) => {
      setBusyById((prev) => ({ ...prev, [id]: true }));
      await decideToolCallApi(id, accept, (event) => applyEvent(id, event)).finally(() => {
        setBusyById((prev) => ({ ...prev, [id]: false }));
      });
    },
    [applyEvent],
  );

  const posts = Object.values(postsById).sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return {
    posts,
    selectedId,
    selectedPost: selectedId ? postsById[selectedId] : undefined,
    eventsFor: (id: string) => eventsById[id] ?? [],
    streamingFor: (id: string) => streamingById[id] ?? '',
    isBusy: (id: string) => busyById[id] ?? false,
    select,
    newDraft,
    submitReview,
    decideToolCall,
    refresh,
  };
};

export type Runs = ReturnType<typeof useRuns>;
