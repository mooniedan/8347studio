// Lock-free SPSC byte ring backed by a SharedArrayBuffer.
//
// Layout:
//   [ head: u32 (LE) | tail: u32 (LE) | data: capacity bytes ]
// `capacity` is the byte count of the data region (must be a power of two).
// Each event written is preceded by a 4-byte little-endian length prefix
// followed by `length` payload bytes; both header and payload may wrap
// around the end of the data region.
//
// Single producer (main thread, JS) writes events; single consumer (audio
// thread, Rust) drains them inside the audio block. Atomics use Acquire
// on the read side and Release on the write side to publish completed
// writes — this matches the `Atomics.load` / `Atomics.store` semantics
// the JS writer will use.

use core::sync::atomic::{AtomicU32, Ordering};

pub const HEAD_OFFSET: usize = 0;
pub const TAIL_OFFSET: usize = 4;
pub const DATA_OFFSET: usize = 8;
pub const HEADER_BYTES: usize = DATA_OFFSET;

pub const LEN_PREFIX_BYTES: usize = 4;

/// Reader-side view over a SAB-style ring. The reader owns `tail`; `head`
/// is updated by the writer.
pub struct RingReader<'a> {
    buffer: &'a mut [u8],
}

impl<'a> RingReader<'a> {
    /// `buffer` must point at the full SAB region, header included. The
    /// data region length (`buffer.len() - HEADER_BYTES`) must be a power
    /// of two ≥ LEN_PREFIX_BYTES.
    pub fn new(buffer: &'a mut [u8]) -> Self {
        debug_assert!(buffer.len() > HEADER_BYTES);
        let cap = buffer.len() - HEADER_BYTES;
        debug_assert!(cap.is_power_of_two());
        debug_assert!(cap >= LEN_PREFIX_BYTES);
        Self { buffer }
    }

    pub fn capacity(&self) -> usize {
        self.buffer.len() - HEADER_BYTES
    }

    fn head(&self) -> u32 {
        atomic_at(self.buffer, HEAD_OFFSET).load(Ordering::Acquire)
    }

    fn tail(&self) -> u32 {
        atomic_at(self.buffer, TAIL_OFFSET).load(Ordering::Relaxed)
    }

    fn store_tail(&mut self, v: u32) {
        atomic_at(self.buffer, TAIL_OFFSET).store(v, Ordering::Release);
    }

    /// Drain every fully-written event in the ring, calling `f` on each
    /// payload. Returns the number of events drained.
    pub fn drain<F>(&mut self, mut f: F) -> usize
    where
        F: FnMut(&[u8]),
    {
        let cap = self.capacity();
        let mask = (cap - 1) as u32;
        let head = self.head();
        let mut tail = self.tail();
        let mut count = 0;

        while tail != head {
            let available = head.wrapping_sub(tail);
            if (available as usize) < LEN_PREFIX_BYTES {
                break; // partial header, writer mid-flight
            }
            let len = read_len_at(self.buffer, tail, mask);
            let total = LEN_PREFIX_BYTES as u32 + len;
            if available < total {
                break; // partial payload, writer mid-flight
            }
            let mut payload = [0u8; 256];
            // Most events are tiny; for very long events we allocate.
            let payload_buf: alloc::vec::Vec<u8>;
            let bytes: &[u8] = if (len as usize) <= payload.len() {
                copy_from_ring(
                    self.buffer,
                    tail.wrapping_add(LEN_PREFIX_BYTES as u32),
                    mask,
                    &mut payload[..len as usize],
                );
                &payload[..len as usize]
            } else {
                payload_buf = read_payload_alloc(self.buffer, tail, mask, len as usize);
                &payload_buf
            };
            f(bytes);
            tail = tail.wrapping_add(total);
            count += 1;
        }
        self.store_tail(tail);
        count
    }
}

/// Writer-side view (used by host-side tests; the production writer is
/// in TypeScript). Returns true on success, false if the event doesn't
/// fit at this moment.
pub struct RingWriter<'a> {
    buffer: &'a mut [u8],
}

impl<'a> RingWriter<'a> {
    pub fn new(buffer: &'a mut [u8]) -> Self {
        debug_assert!(buffer.len() > HEADER_BYTES);
        let cap = buffer.len() - HEADER_BYTES;
        debug_assert!(cap.is_power_of_two());
        Self { buffer }
    }

    pub fn capacity(&self) -> usize {
        self.buffer.len() - HEADER_BYTES
    }

    fn head(&self) -> u32 {
        atomic_at(self.buffer, HEAD_OFFSET).load(Ordering::Relaxed)
    }

    fn tail(&self) -> u32 {
        atomic_at(self.buffer, TAIL_OFFSET).load(Ordering::Acquire)
    }

    fn store_head(&mut self, v: u32) {
        atomic_at(self.buffer, HEAD_OFFSET).store(v, Ordering::Release);
    }

    pub fn write(&mut self, payload: &[u8]) -> bool {
        let cap = self.capacity();
        let mask = (cap - 1) as u32;
        let head = self.head();
        let tail = self.tail();
        let used = head.wrapping_sub(tail) as usize;
        let total = LEN_PREFIX_BYTES + payload.len();
        if used + total > cap {
            return false;
        }
        write_len_at(self.buffer, head, mask, payload.len() as u32);
        copy_to_ring(
            self.buffer,
            head.wrapping_add(LEN_PREFIX_BYTES as u32),
            mask,
            payload,
        );
        self.store_head(head.wrapping_add(total as u32));
        true
    }
}

/// Initialize the header (zero head + tail). Called once at setup.
pub fn init(buffer: &mut [u8]) {
    debug_assert!(buffer.len() > HEADER_BYTES);
    atomic_at(buffer, HEAD_OFFSET).store(0, Ordering::Relaxed);
    atomic_at(buffer, TAIL_OFFSET).store(0, Ordering::Relaxed);
}

fn atomic_at(buffer: &[u8], offset: usize) -> &AtomicU32 {
    debug_assert!(offset + 4 <= buffer.len());
    debug_assert!(offset % 4 == 0);
    // Safety: `AtomicU32` has the same memory layout as `u32`, and we know
    // the offset is 4-aligned within the buffer (the SAB header lives at
    // offsets 0 and 4).
    unsafe { &*(buffer.as_ptr().add(offset) as *const AtomicU32) }
}

fn read_len_at(buffer: &[u8], pos: u32, mask: u32) -> u32 {
    let mut bytes = [0u8; 4];
    for i in 0..4 {
        bytes[i] = buffer[DATA_OFFSET + (pos.wrapping_add(i as u32) & mask) as usize];
    }
    u32::from_le_bytes(bytes)
}

fn write_len_at(buffer: &mut [u8], pos: u32, mask: u32, len: u32) {
    let bytes = len.to_le_bytes();
    for i in 0..4 {
        buffer[DATA_OFFSET + (pos.wrapping_add(i as u32) & mask) as usize] = bytes[i];
    }
}

fn copy_from_ring(buffer: &[u8], pos: u32, mask: u32, out: &mut [u8]) {
    for (i, b) in out.iter_mut().enumerate() {
        *b = buffer[DATA_OFFSET + (pos.wrapping_add(i as u32) & mask) as usize];
    }
}

fn copy_to_ring(buffer: &mut [u8], pos: u32, mask: u32, src: &[u8]) {
    for (i, b) in src.iter().enumerate() {
        buffer[DATA_OFFSET + (pos.wrapping_add(i as u32) & mask) as usize] = *b;
    }
}

fn read_payload_alloc(buffer: &[u8], tail: u32, mask: u32, len: usize) -> alloc::vec::Vec<u8> {
    let start = tail.wrapping_add(LEN_PREFIX_BYTES as u32);
    let mut v = alloc::vec::Vec::with_capacity(len);
    for i in 0..len {
        v.push(buffer[DATA_OFFSET + (start.wrapping_add(i as u32) & mask) as usize]);
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_buffer(data_cap: usize) -> alloc::vec::Vec<u8> {
        let mut b = alloc::vec![0u8; HEADER_BYTES + data_cap];
        init(&mut b);
        b
    }

    #[test]
    fn round_trips_a_single_event() {
        let mut buf = fresh_buffer(64);
        {
            let mut w = RingWriter::new(&mut buf);
            assert!(w.write(b"hello"));
        }
        let mut r = RingReader::new(&mut buf);
        let mut received: alloc::vec::Vec<alloc::vec::Vec<u8>> = alloc::vec::Vec::new();
        let n = r.drain(|p| received.push(p.to_vec()));
        assert_eq!(n, 1);
        assert_eq!(received, alloc::vec![b"hello".to_vec()]);
    }

    #[test]
    fn drains_multiple_events_in_order() {
        let mut buf = fresh_buffer(64);
        {
            let mut w = RingWriter::new(&mut buf);
            assert!(w.write(b"one"));
            assert!(w.write(b"two"));
            assert!(w.write(b"three"));
        }
        let mut r = RingReader::new(&mut buf);
        let mut got: alloc::vec::Vec<alloc::vec::Vec<u8>> = alloc::vec::Vec::new();
        r.drain(|p| got.push(p.to_vec()));
        assert_eq!(got.len(), 3);
        assert_eq!(got[0], b"one");
        assert_eq!(got[1], b"two");
        assert_eq!(got[2], b"three");
    }

    #[test]
    fn rejects_writes_that_dont_fit() {
        let mut buf = fresh_buffer(16); // 16-byte data region
        let mut w = RingWriter::new(&mut buf);
        // 4 bytes len prefix + 8 bytes payload = 12; fits.
        assert!(w.write(&[0xAB; 8]));
        // Next write would need 4 + 6 = 10 bytes; only 4 free.
        assert!(!w.write(&[0xCD; 6]));
    }

    #[test]
    fn handles_payload_wrap_around_the_buffer_boundary() {
        let mut buf = fresh_buffer(16);
        // Burn 12 bytes, leave head at 12.
        {
            let mut w = RingWriter::new(&mut buf);
            assert!(w.write(&[0x11; 8]));
        }
        // Drain it so tail moves forward; now head=tail=12.
        {
            let mut r = RingReader::new(&mut buf);
            r.drain(|_| {});
        }
        // Write 7 bytes; payload itself spans the boundary
        // (4-byte len at offsets 12,13,14,15; 7-byte payload at
        // 0,1,2,3,4,5,6).
        {
            let mut w = RingWriter::new(&mut buf);
            assert!(w.write(&[1, 2, 3, 4, 5, 6, 7]));
        }
        let mut r = RingReader::new(&mut buf);
        let mut got: alloc::vec::Vec<u8> = alloc::vec::Vec::new();
        r.drain(|p| got.extend_from_slice(p));
        assert_eq!(got, alloc::vec![1, 2, 3, 4, 5, 6, 7]);
    }

    #[test]
    fn drain_on_empty_ring_is_a_noop() {
        let mut buf = fresh_buffer(16);
        let mut r = RingReader::new(&mut buf);
        let n = r.drain(|_| panic!("should not call f"));
        assert_eq!(n, 0);
    }
}
