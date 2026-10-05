import { describe, expect, it } from 'vitest';
import { listField } from '../../src/pages/controls';

describe('tag listField component', () => {
  it('renders existing tags as chips with remove buttons', () => {
    const result = listField({
      name: 'skills.frameworks',
      label: 'Frameworks',
      values: ['React', 'Next.js'],
    });

    const host = document.createElement('div');
    host.innerHTML = result.__html;

    const tags = Array.from(host.querySelectorAll('.tag'));
    expect(tags.length).toBe(2);
    expect(tags[0].textContent).toContain('React');
    expect(tags[1].textContent).toContain('Next.js');

    const removeBtns = host.querySelectorAll('button[data-remove-tag]');
    expect(removeBtns.length).toBe(2);
    expect(removeBtns[0].getAttribute('data-remove-tag')).toBe('0');
    expect(removeBtns[1].getAttribute('data-remove-tag')).toBe('1');

    const input = host.querySelector<HTMLInputElement>('input[data-list-input="skills.frameworks"]');
    expect(input).toBeDefined();
    expect(input?.placeholder).toContain('Type and press Enter');
  });

  it('renders an empty tag container when values array is empty', () => {
    const result = listField({
      name: 'technologies',
      label: 'Technologies',
      values: [],
      placeholder: 'Add tech...',
    });

    const host = document.createElement('div');
    host.innerHTML = result.__html;

    const tags = host.querySelectorAll('.tag');
    expect(tags.length).toBe(0);

    const input = host.querySelector<HTMLInputElement>('input[data-list-input="technologies"]');
    expect(input).toBeDefined();
    expect(input?.placeholder).toBe('Add tech...');
  });
});
