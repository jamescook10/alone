// Weather.
//
// A slowly wandering state driven by noise over time, plus fronts that sweep
// through. Rain and snow are drawn as a single instanced mesh animated
// entirely on the GPU, so a downpour costs nothing on the CPU.

import * as THREE from 'three';
import { Noise, clamp, lerp, saturate, smoothstep } from '../core/noise.js';
import { atmo } from '../gfx/atmosphere.js';

const PRECIP_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 aOffset;
attribute float aSeed;
uniform float uTime;
uniform vec3 uCenter;
uniform float uBox;
uniform float uHeight;
uniform float uFall;
uniform vec2 uWind;
uniform float uSnow;
uniform float uShelter;
uniform float uSize;
varying float vAlpha;
varying float vSeed;

void main() {
  vSeed = aSeed;
  vec3 p = aOffset;
  float t = uTime;
  float fall = uFall * ( 0.75 + aSeed * 0.5 );
  p.y = mod( p.y - t * fall, uHeight );
  // Snow drifts; rain is driven almost straight by the wind.
  float driftAmp = mix( 0.35, 3.2, uSnow );
  p.x += uWind.x * t * mix( 1.6, 0.5, uSnow ) + sin( t * ( 0.7 + aSeed ) + aSeed * 30.0 ) * driftAmp;
  p.z += uWind.y * t * mix( 1.6, 0.5, uSnow ) + cos( t * ( 0.6 + aSeed * 1.3 ) + aSeed * 21.0 ) * driftAmp;
  p.x = mod( p.x + uBox * 0.5, uBox ) - uBox * 0.5;
  p.z = mod( p.z + uBox * 0.5, uBox ) - uBox * 0.5;

  vec3 world = uCenter + vec3( p.x, p.y - uHeight * 0.35, p.z );

  // Billboard, stretched along the fall direction for rain streaks.
  vec3 toCam = normalize( cameraPosition - world );
  vec3 up = normalize( mix( vec3( 0.0, 1.0, 0.0 ), normalize( vec3( -uWind.x * 0.25, -1.0, -uWind.y * 0.25 ) ), 1.0 - uSnow ) );
  vec3 right = normalize( cross( up, toCam ) );
  float w = uSize * mix( 0.014, 0.30, uSnow ) * ( 0.6 + aSeed * 0.8 );
  float h = uSize * mix( 1.0, 0.30, uSnow ) * ( 0.6 + aSeed * 0.8 );
  world += right * position.x * w + up * position.y * h;

  float d = length( vec2( p.x, p.z ) );
  vAlpha = ( 1.0 - smoothstep( uBox * 0.30, uBox * 0.5, d ) );
  // Under a roof, the drops near you stop arriving.
  vAlpha *= 1.0 - uShelter * ( 1.0 - smoothstep( 1.5, 9.0, d ) );
  gl_Position = projectionMatrix * viewMatrix * vec4( world, 1.0 );
  #include <logdepthbuf_vertex>
}
`;

const PRECIP_FRAG = /* glsl */ `
precision mediump float;
#include <common>
#include <logdepthbuf_pars_fragment>
varying float vAlpha;
varying float vSeed;
uniform vec3 uColor;
uniform float uOpacity;
void main() {
  #include <logdepthbuf_fragment>
  if ( vAlpha <= 0.01 ) discard;
  gl_FragColor = vec4( uColor, vAlpha * uOpacity );
}
`;

export class Weather {
  constructor(world) {
    this.world = world;
    this.n = new Noise(world.wg.seed ^ 0x5eed);
    this.t = 0;

    this.cloudCover = 0.35;
    this.cloudDark = 0.0;
    this.overcast = 0.0;
    // rain/snow are what is falling *on you*; frontRain/frontSnow are what the
    // weather system is doing across the region. The two differ by whatever
    // happens to be overhead - see the cloud gate in update().
    this.rain = 0;
    this.snow = 0;
    this.frontRain = 0;
    this.frontSnow = 0;
    this.underCloud = 1;
    this.cloudBase = Infinity;
    this.wind = 0.35;
    this.windAngle = 0.8;
    this.windDir = new THREE.Vector2(1, 0.2).normalize();
    this.humidity = 0.5;
    this.fog = 0;
    this.aurora = 0;
    this.lightning = 0;
    this.thunderQueue = [];
    this.wetness = 0;
    this.snowCover = 0;
    this.shelter = 0;
    this.temperature = 15;
    this.name = 'clear';

    // Start each world somewhere calm in the weather's history, so the first
    // thing you see is a settled morning rather than a squall.
    for (let k = 0; k < 4000; k++) {
      const t = k * 7.5;
      if (this.n.fbm2(t * 0.0042, 11.5, 3) * 0.5 + 0.5 < 0.22) {
        this.t = t;
        break;
      }
    }

    this._buildPrecip();
    this.flashLight = new THREE.PointLight(0xbcd0ff, 0, 900, 1.2);
    this.flashLight.visible = false;
    world.engine.scene.add(this.flashLight);
  }

  _buildPrecip() {
    const COUNT = 7000;
    const box = 46;
    const height = 34;
    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.attributes.position = quad.attributes.position;
    geo.attributes.uv = quad.attributes.uv;
    const off = new Float32Array(COUNT * 3);
    const seed = new Float32Array(COUNT);
    for (let i = 0; i < COUNT; i++) {
      off[i * 3] = (Math.random() - 0.5) * box;
      off[i * 3 + 1] = Math.random() * height;
      off[i * 3 + 2] = (Math.random() - 0.5) * box;
      seed[i] = Math.random();
    }
    geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(off, 3));
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 1));
    geo.instanceCount = COUNT;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.precipUniforms = {
      uTime: { value: 0 },
      uCenter: { value: new THREE.Vector3() },
      uBox: { value: box },
      uHeight: { value: height },
      uFall: { value: 18 },
      uWind: { value: new THREE.Vector2() },
      uSnow: { value: 0 },
      uShelter: { value: 0 },
      uSize: { value: 0.9 },
      uColor: { value: new THREE.Color(0.72, 0.80, 0.90) },
      uOpacity: { value: 0 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.precipUniforms,
      vertexShader: PRECIP_VERT,
      fragmentShader: PRECIP_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.precip = new THREE.Mesh(geo, mat);
    this.precip.frustumCulled = false;
    this.precip.renderOrder = 20;
    this.precip.visible = false;
    this.world.engine.scene.add(this.precip);
    this.precipCount = COUNT;
  }

  /** Force a particular weather for a while (used by the debug/photo keys). */
  force(kind, instant = true) {
    this._forced = kind;
    this._forcedT = 0;
    if (instant && (kind === 'clear' || kind === 'cloudy' || kind === 'fog')) {
      this.rain = this.frontRain = 0;
      this.snow = this.frontSnow = 0;
    }
  }

  update(dt, player) {
    this.t += dt;
    const T = this.t;

    // Local climate from the world, so a desert stays dry and a mountain
    // gets snow instead of rain.
    const s = player ? this.world.terrain.sampleAt(player.position.x, player.position.z) : null;
    const localTemp = s ? s.temperature : 15;
    const localMoist = s ? s.moisture : 0.5;

    // Slow evolution: two noise fields, one for cloud, one for fronts.
    let front = this.n.fbm2(T * 0.0042, 11.5, 3) * 0.5 + 0.5;
    let damp = this.n.fbm2(T * 0.0021 + 40, -7.5, 2) * 0.5 + 0.5;
    if (this._forced) {
      const f = { clear: 0.05, cloudy: 0.5, rain: 0.82, storm: 0.97, fog: 0.45, snow: 0.85 }[this._forced];
      if (f !== undefined) {
        front = f;
        damp = this._forced === 'fog' ? 0.95 : 0.5;
      }
      this._forcedT += dt;
      if (this._forcedT > 420) this._forced = null;
    }

    const wetBias = (localMoist - 0.5) * 0.42;
    const stormy = saturate((front + wetBias - 0.52) / 0.42);

    this.cloudCover = saturate(lerp(0.10, 0.98, saturate(front + wetBias * 0.8)));
    this.overcast = saturate((this.cloudCover - 0.55) / 0.42);
    this.cloudDark = stormy * 0.9;

    const wantPrecip = saturate((stormy - 0.18) / 0.5) * saturate(localMoist * 1.6);
    const freezing = smoothstep(2.5, -1.5, localTemp);
    this.frontRain = lerp(this.frontRain, wantPrecip * (1 - freezing), 1 - Math.exp(-dt * 0.22));
    this.frontSnow = lerp(this.frontSnow, wantPrecip * freezing, 1 - Math.exp(-dt * 0.18));

    // Precipitation has to fall out of something. The front decides whether
    // the region is wet; the cloud field decides whether it is wet *here* -
    // under a cluster yes, under a gap in the same front no, and above the
    // deck never, which is what used to leave the aeroplane flying through
    // rain in clear air 2 km up. Faster than the front's own drift so a shaft
    // arrives and leaves as you walk under its edge, slow enough that it
    // fades rather than switches.
    let gate = 1;
    if (player && this.world.clouds) {
      const above = this.world.clouds.sampleAt(player.position.x, player.position.z);
      this.cloudBase = above.base;
      gate = Number.isFinite(above.base)
        ? above.cover * smoothstep(above.base, above.base - 90, player.position.y)
        : 0;
    }
    this.underCloud = lerp(this.underCloud, gate, 1 - Math.exp(-dt * 0.8));
    this.rain = this.frontRain * this.underCloud;
    this.snow = this.frontSnow * this.underCloud;

    this.windAngle += (this.n.noise2(T * 0.006, 3.3)) * dt * 0.22;
    const gust = 0.6 + 0.4 * (this.n.noise2(T * 0.35, 91.2) * 0.5 + 0.5);
    this.wind = lerp(0.12, 1.5, saturate(front * 0.7 + stormy * 0.6)) * gust;
    this.windDir.set(Math.cos(this.windAngle), Math.sin(this.windAngle));

    this.humidity = saturate(0.15 + localMoist * 0.42 + this.rain * 0.4);
    // Valley fog on calm, damp mornings. The window is ±~1h around 06:30,
    // fading out over the next hour - the old (0.30, 0.24) edges kept "dawn"
    // fully on from 3 am until past noon, which is why every morning looked
    // like soup until lunchtime.
    const dawn = this.world.sky ? smoothstep(0.085, 0.045, Math.abs(this.world.sky.time - 0.27)) : 0;
    this.fog = saturate(damp * 0.8 * (1 - stormy) * (0.25 + dawn) + this.rain * 0.25);
    this.temperature = localTemp;

    // Aurora: cold, clear, dark.
    this.aurora = saturate((1 - this.cloudCover) * smoothstep(6, -8, localTemp) * 1.2);

    /* --- lightning ------------------------------------------------------ */
    this.lightning = Math.max(0, this.lightning - dt * 6);
    if (stormy > 0.72 && Math.random() < dt * (stormy - 0.7) * 2.4) {
      this.lightning = 1;
      const dist = 90 + Math.random() * 2600;
      this.thunderQueue.push({ t: dist / 340, dist });
      const ang = Math.random() * Math.PI * 2;
      if (player) {
        this.flashLight.position.set(
          player.position.x + Math.cos(ang) * dist * 0.3,
          player.position.y + 400 + Math.random() * 500,
          player.position.z + Math.sin(ang) * dist * 0.3
        );
      }
    }
    this.flashLight.visible = this.lightning > 0.01;
    this.flashLight.intensity = this.lightning * 90000;

    for (let i = this.thunderQueue.length - 1; i >= 0; i--) {
      this.thunderQueue[i].t -= dt;
      if (this.thunderQueue[i].t <= 0) {
        this.world.audio && this.world.audio.thunder(this.thunderQueue[i].dist);
        this.thunderQueue.splice(i, 1);
      }
    }

    /* --- accumulation --------------------------------------------------- */
    // Wet ground and lying snow are one number for the whole world, so they
    // follow the front rather than the shaft: the showers have been over this
    // country all morning even if there is blue sky directly above you now.
    const exposed = 1 - this.shelter;
    this.wetness = saturate(this.wetness + (this.frontRain * exposed * 0.06 - 0.012) * dt);
    this.snowCover = saturate(this.snowCover + (this.frontSnow * 0.03 - (localTemp > 1 ? 0.02 : 0)) * dt);

    /* --- shared uniforms ------------------------------------------------ */
    atmo.uWind.value.copy(this.windDir);
    atmo.uWindStrength.value = this.wind;
    atmo.uWetness.value = this.wetness;
    // Only what has actually fallen. Permanent snow - the line up a mountain,
    // the white of a tundra - now comes from uClimateTemp, which every
    // material evaluates against its own altitude.
    atmo.uSnowAmount.value = this.snowCover;
    // When the auto-quality ladder pulls the far plane in, thicker fog hides
    // the cut instead of showing sky through the missing horizon.
    const farK = this.world.engine.quality.farK || 1;
    const fogBoost = farK < 1 ? 3.2 : 1;
    atmo.uFogDensity.value = (lerp(0.00014, 0.0032, this.fog * this.fog) + this.rain * 0.0007) * fogBoost;
    atmo.uFogFalloff.value = lerp(0.0016, 0.0068, this.fog);

    /* --- precipitation mesh --------------------------------------------- */
    const amt = Math.max(this.rain, this.snow);
    this.precip.visible = amt > 0.01;
    if (this.precip.visible && player) {
      const u = this.precipUniforms;
      u.uTime.value = T;
      u.uCenter.value.copy(player.position);
      u.uWind.value.copy(this.windDir).multiplyScalar(this.wind * 3.2);
      const snowy = this.snow > this.rain ? 1 : 0;
      u.uSnow.value = lerp(u.uSnow.value, snowy, 1 - Math.exp(-dt * 2));
      u.uFall.value = lerp(24, 2.6, u.uSnow.value);
      u.uSize.value = lerp(2.2, 0.42, u.uSnow.value);
      u.uColor.value.setRGB(
        lerp(0.62, 0.95, u.uSnow.value),
        lerp(0.70, 0.96, u.uSnow.value),
        lerp(0.85, 1.0, u.uSnow.value)
      );
      u.uOpacity.value = clamp(amt * lerp(0.30, 0.85, u.uSnow.value), 0, 1);
      u.uShelter.value = this.shelter;
      this.precip.geometry.instanceCount = Math.floor(this.precipCount * clamp(amt * 1.3, 0.05, 1));
    }

    this.name = this._describe();
  }

  _describe() {
    if (this.snow > 0.45) return 'snowing';
    if (this.snow > 0.1) return 'light snow';
    if (this.rain > 0.62) return this.lightning > 0 || this.cloudDark > 0.7 ? 'thunderstorm' : 'heavy rain';
    if (this.rain > 0.25) return 'rain';
    if (this.rain > 0.05) return 'drizzle';
    if (this.fog > 0.55) return 'fog';
    if (this.overcast > 0.6) return 'overcast';
    if (this.cloudCover > 0.45) return 'cloudy';
    if (this.cloudCover > 0.2) return 'fair';
    return 'clear';
  }

  /** 0 = out in the open, 1 = fully under cover. */
  setShelter(v) {
    this.shelter = v;
  }

  get precipitation() {
    return Math.max(this.rain, this.snow);
  }
}
