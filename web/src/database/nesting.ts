import { createContext, useContext } from 'react';

/**
 * The databases open around this spot, outermost first. A database shown inside one of its own cards
 * (a view of it in the card's page) would open that card again inside itself, forever; embedded
 * views check this and show a note instead.
 */
export const OpenDatabases = createContext<string[]>([]);

export const useOpenDatabases = () => useContext(OpenDatabases);

/** How deep databases may sit inside each other's cards before the next one is left out. */
export const MAX_NESTED_DATABASES = 3;
