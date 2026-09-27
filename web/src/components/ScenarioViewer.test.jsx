import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import ScenarioViewer from './ScenarioViewer.jsx';

const state = vi.hoisted(() => ({ loads: [], renderers: [], controls: [], failRenderer: false }));
vi.mock('three', async (importOriginal) => {
  const real = await importOriginal();
  class WebGLRenderer {
    constructor() {
      if (state.failRenderer) throw new Error('WebGL not available');
      this.domElement = document.createElement('canvas');
      this.setPixelRatio = vi.fn(); this.setSize = vi.fn(); this.render = vi.fn(); this.dispose = vi.fn(); this.forceContextLoss = vi.fn();
      state.renderers.push(this);
    }
  }
  class TextureLoader {
    setCrossOrigin(value) { expect(value).toBe('anonymous'); return this; }
    load(url, ready, _progress, failed) {
      const texture = new real.Texture(); vi.spyOn(texture, 'dispose');
      state.loads.push({ url, ready, failed, texture }); return texture;
    }
  }
  return { ...real, WebGLRenderer, TextureLoader };
});
vi.mock('three/addons/controls/OrbitControls.js', () => ({
  OrbitControls: class {
    constructor() { this.target = { set: vi.fn() }; this.update = vi.fn(); this.dispose = vi.fn(); state.controls.push(this); }
  },
}));
const ring = [[-122.4252,37.7669],[-122.4248,37.7669],[-122.4248,37.7671],[-122.4252,37.7671],[-122.4252,37.7669]];
const props = {
  area:[-122.433,37.758,-122.417,37.776],
  candidate:{id:'plot-a',longitude:-122.425,latitude:37.767,footprint:{type:'Polygon',coordinates:[ring]}},
  building:{width_m:24,depth_m:18,height_m:12,setback_m:3},serviceType:'clinic',
  dataset:{scenario_status:'MOCK_SIMULATION',features:[{id:'plot-a',properties:{layer:'candidate_site'},geometry:{type:'Polygon',coordinates:[ring]}}]},
};
beforeEach(() => {
  state.loads.length = 0; state.renderers.length = 0; state.controls.length = 0; state.failRenderer = false;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({measureText:(text)=>({width:text.length*11}),fillRect:vi.fn(),fillText:vi.fn()});
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', vi.fn(()=>41)); vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('loads only nine current-view public street tiles, keeps attribution, and tolerates partial failure', () => {
  render(<ScenarioViewer {...props} />);
  expect(state.loads).toHaveLength(9);
  expect(state.loads.every(({url})=>/^https:\/\/tile\.openstreetmap\.org\/18\/\d+\/\d+\.png$/.test(url))).toBe(true);
  expect(screen.getByRole('link', {name:'OpenStreetMap'})).toHaveAttribute('href','https://www.openstreetmap.org/copyright');
  act(() => { state.loads[0].failed(); state.loads.slice(1).forEach(({ready,texture})=>ready(texture)); });
  expect(screen.getByRole('status')).toHaveTextContent('Some street tiles unavailable');
  expect(screen.getByText(/Candidate land records are simulated/)).toBeInTheDocument();
});

it('releases the old view and late textures, switches neighborhood scale, and cleans up on unmount', () => {
  const rendered = render(<ScenarioViewer {...props} />); const oldLoads = [...state.loads];
  fireEvent.click(screen.getByRole('button',{name:'Neighborhood'}));
  expect(screen.getByRole('button',{name:'Neighborhood'})).toHaveAttribute('aria-pressed','true');
  expect(state.loads).toHaveLength(18); expect(state.loads.slice(9).every(({url})=>url.includes('/16/'))).toBe(true);
  expect(state.renderers[0].dispose).toHaveBeenCalledTimes(1); expect(state.controls[0].dispose).toHaveBeenCalledTimes(1);
  const beforeLate = oldLoads[0].texture.dispose.mock.calls.length;
  act(() => oldLoads[0].ready(oldLoads[0].texture));
  expect(oldLoads[0].texture.dispose).toHaveBeenCalledTimes(beforeLate+1);
  expect(screen.getByRole('status')).toHaveTextContent('Loading street map');
  fireEvent.click(screen.getByRole('button',{name:'Reset'}));
  expect(state.controls[1].update.mock.calls.length).toBeGreaterThan(1);
  rendered.unmount();
  expect(state.renderers[1].dispose).toHaveBeenCalledTimes(1);
  expect(state.loads.every(({texture})=>texture.dispose.mock.calls.length>0)).toBe(true);
  expect(cancelAnimationFrame).toHaveBeenCalled();
});

it('shows an accessible fallback and retries context creation after a view change', () => {
  state.failRenderer = true; render(<ScenarioViewer {...props} />);
  expect(screen.getByRole('status')).toHaveTextContent('3D is unavailable'); expect(state.loads).toHaveLength(0);
  state.failRenderer = false; fireEvent.click(screen.getByRole('button',{name:'Neighborhood'}));
  expect(state.loads).toHaveLength(9); expect(screen.queryByText(/3D is unavailable/)).not.toBeInTheDocument();
  act(()=>state.loads.forEach(({failed})=>failed()));
  expect(screen.getByRole('status')).toHaveTextContent('Street map unavailable; supplied geometry remains visible.');
});

