export const draftKey = (owner: string, id: string, cleaned = false) => `speak.draft.${owner}.${id}.${cleaned ? 'cleaned' : 'original'}`;
