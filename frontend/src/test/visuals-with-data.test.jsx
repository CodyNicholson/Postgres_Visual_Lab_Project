import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { DEMOS } from '../demos/catalog.js';
import { defaultInputs } from '../components/DemoView.jsx';
import { VISUALS } from '../visuals/index.js';
import RESULTS from './fixtures/results.json';

// Real DemoResults captured from the backend (normal run and "Do it wrong"), so every visual is
// rendered with the data shapes Postgres actually returns. Refresh with the script in the README.
const cases = Object.entries(RESULTS).map(([key, result]) => [key, DEMOS.find((d) => d.id === key.split(':')[0]), result]);

describe('visuals with real results', () => {
  it('has a fixture for every demo', () => {
    DEMOS.forEach((demo) => expect(RESULTS[`${demo.id}:run`], demo.id).toBeTruthy());
  });

  it.each(cases)('%s renders', (_, demo, result) => {
    const Visual = VISUALS[demo.visual];
    const { container } = render(
      <Visual demo={demo} result={{ ...result, receivedAt: 1 }} history={[result]} inputs={defaultInputs(demo)} run={() => {}} busy={null} />,
    );
    expect(container.textContent.length).toBeGreaterThan(20);
  });
});
