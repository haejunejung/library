import React from 'react';
import { useRef } from 'react';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const useContextBridge = (...contexts: Array<React.Context<any>>) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const contextValues = useRef<Array<React.Context<any>>>([]);
  contextValues.current = contexts.map((context) => React.useContext(context));
  return React.useMemo(
    () =>
      ({ children }: React.PropsWithChildren) =>
        contexts.reduceRight(
          (acc, Context, index) => (
            <Context.Provider value={contextValues.current.at(index)}>{acc}</Context.Provider>
          ),
          children,
        ),
    [],
  );
};
