// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { InfoTip } from './InfoTip.tsx';
import { HOSTILE } from './testing.tsx';

afterEach(cleanup);

const button = () => screen.getByRole('button', { name: 'More about trusted' }) as HTMLButtonElement;
const popover = () => document.getElementById(button().getAttribute('aria-controls') ?? '') as HTMLElement;

describe('the info button', () => {
  it('is a button named by its topic, closed at first, that controls the text', () => {
    render(<InfoTip topic="trusted">Long words.</InfoTip>);
    expect(button().type).toBe('button');
    expect(button().getAttribute('aria-expanded')).toBe('false');
    expect(popover().hidden).toBe(true);
    expect(popover().textContent).toBe('Long words.');
  });

  it('opens on a click and closes on a second one', () => {
    render(<InfoTip topic="trusted">Long words.</InfoTip>);
    fireEvent.click(button());
    expect(button().getAttribute('aria-expanded')).toBe('true');
    expect(popover().hidden).toBe(false);
    fireEvent.click(button());
    expect(button().getAttribute('aria-expanded')).toBe('false');
    expect(popover().hidden).toBe(true);
  });

  it('closes on Escape and gives the focus back to the button', () => {
    render(
      <>
        <InfoTip topic="trusted">Long words.</InfoTip>
        <input aria-label="elsewhere" />
      </>,
    );
    fireEvent.click(button());
    screen.getByLabelText('elsewhere').focus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(popover().hidden).toBe(true);
    expect(document.activeElement).toBe(button());
  });

  it('closes when the press is outside, and stays open when it is inside', () => {
    render(
      <>
        <InfoTip topic="trusted">Long words.</InfoTip>
        <p>outside</p>
      </>,
    );
    fireEvent.click(button());
    fireEvent.pointerDown(popover());
    expect(popover().hidden).toBe(false);
    fireEvent.pointerDown(screen.getByText('outside'));
    expect(popover().hidden).toBe(true);
  });

  it('does not close and reopen when the button itself is pressed while it is open', () => {
    render(<InfoTip topic="trusted">Long words.</InfoTip>);
    fireEvent.click(button());
    fireEvent.pointerDown(button());
    fireEvent.click(button());
    expect(popover().hidden).toBe(true);
  });

  it('keeps one open at a time: pressing another one closes the first', () => {
    render(
      <>
        <InfoTip topic="trusted">One.</InfoTip>
        <InfoTip topic="edit">Two.</InfoTip>
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'More about trusted' }));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'More about edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'More about edit' }));
    expect(screen.getByRole('button', { name: 'More about trusted' }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('button', { name: 'More about edit' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('draws no image and no emoji: a shape of its own', () => {
    const { container } = render(<InfoTip topic="trusted">Long words.</InfoTip>);
    expect(container.querySelector('img')).toBeNull();
    expect(button().textContent).toBe('');
    expect(button().querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('shows hostile text as text only', () => {
    const { container } = render(<InfoTip topic="trusted">{`${HOSTILE.markup} ${HOSTILE.link}`}</InfoTip>);
    fireEvent.click(button());
    expect(container.querySelector('img, script, a')).toBeNull();
    expect(popover().textContent).toBe(`${HOSTILE.markup} ${HOSTILE.link}`);
  });

  it('puts no inline style on the page', () => {
    const { container } = render(<InfoTip topic="trusted">Long words.</InfoTip>);
    fireEvent.click(button());
    expect(container.querySelector('[style]')).toBeNull();
  });
});
