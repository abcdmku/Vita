use std::fmt::{self, Display, Formatter};
use std::io::{self, Write};

const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
const COLOR_TYPE_RGBA: u8 = 6;
const BIT_DEPTH_EIGHT: u8 = 8;
const ZLIB_NO_COMPRESSION: [u8; 2] = [0x78, 0x01];
const MAX_DEFLATE_STORED_BLOCK: usize = u16::MAX as usize;

#[derive(Debug)]
pub enum EncodingError {
    Io(io::Error),
    InvalidData(String),
}

impl Display for EncodingError {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(f, "{error}"),
            Self::InvalidData(reason) => f.write_str(reason),
        }
    }
}

impl std::error::Error for EncodingError {}

impl From<io::Error> for EncodingError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum ColorType {
    Rgba,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum BitDepth {
    Eight,
}

pub struct Encoder<W: Write> {
    writer: W,
    width: u32,
    height: u32,
    color: ColorType,
    depth: BitDepth,
}

impl<W: Write> Encoder<W> {
    pub fn new(writer: W, width: u32, height: u32) -> Self {
        Self {
            writer,
            width,
            height,
            color: ColorType::Rgba,
            depth: BitDepth::Eight,
        }
    }

    pub fn set_color(&mut self, color: ColorType) {
        self.color = color;
    }

    pub fn set_depth(&mut self, depth: BitDepth) {
        self.depth = depth;
    }

    pub fn write_header(mut self) -> Result<Writer<W>, EncodingError> {
        if self.width == 0 || self.height == 0 {
            return Err(EncodingError::InvalidData(
                "PNG dimensions must be non-zero".to_owned(),
            ));
        }
        if self.color != ColorType::Rgba || self.depth != BitDepth::Eight {
            return Err(EncodingError::InvalidData(
                "only 8-bit RGBA PNG output is supported".to_owned(),
            ));
        }

        self.writer.write_all(PNG_SIGNATURE)?;
        let mut ihdr = Vec::with_capacity(13);
        ihdr.extend_from_slice(&self.width.to_be_bytes());
        ihdr.extend_from_slice(&self.height.to_be_bytes());
        ihdr.push(BIT_DEPTH_EIGHT);
        ihdr.push(COLOR_TYPE_RGBA);
        ihdr.push(0);
        ihdr.push(0);
        ihdr.push(0);
        write_chunk(&mut self.writer, b"IHDR", &ihdr)?;

        Ok(Writer {
            writer: self.writer,
            width: self.width,
            height: self.height,
            finished: false,
        })
    }
}

pub struct Writer<W: Write> {
    writer: W,
    width: u32,
    height: u32,
    finished: bool,
}

impl<W: Write> Writer<W> {
    pub fn write_image_data(&mut self, data: &[u8]) -> Result<(), EncodingError> {
        if self.finished {
            return Err(EncodingError::InvalidData(
                "PNG image data has already been written".to_owned(),
            ));
        }
        let row_bytes = checked_row_bytes(self.width)?;
        let expected = row_bytes
            .checked_mul(self.height as usize)
            .ok_or_else(|| EncodingError::InvalidData("PNG image is too large".to_owned()))?;
        if data.len() != expected {
            return Err(EncodingError::InvalidData(format!(
                "expected {expected} RGBA bytes, got {}",
                data.len()
            )));
        }

        let mut filtered = Vec::with_capacity(expected + self.height as usize);
        for row in data.chunks_exact(row_bytes) {
            filtered.push(0);
            filtered.extend_from_slice(row);
        }

        let compressed = zlib_store(&filtered);
        write_chunk(&mut self.writer, b"IDAT", &compressed)?;
        write_chunk(&mut self.writer, b"IEND", &[])?;
        self.finished = true;
        Ok(())
    }
}

fn checked_row_bytes(width: u32) -> Result<usize, EncodingError> {
    (width as usize)
        .checked_mul(4)
        .ok_or_else(|| EncodingError::InvalidData("PNG row is too wide".to_owned()))
}

fn write_chunk<W: Write>(
    writer: &mut W,
    chunk_type: &[u8; 4],
    data: &[u8],
) -> Result<(), EncodingError> {
    let length = u32::try_from(data.len())
        .map_err(|_| EncodingError::InvalidData("PNG chunk is too large".to_owned()))?;
    writer.write_all(&length.to_be_bytes())?;
    writer.write_all(chunk_type)?;
    writer.write_all(data)?;

    let mut crc_data = Vec::with_capacity(chunk_type.len() + data.len());
    crc_data.extend_from_slice(chunk_type);
    crc_data.extend_from_slice(data);
    writer.write_all(&crc32(&crc_data).to_be_bytes())?;
    Ok(())
}

fn zlib_store(data: &[u8]) -> Vec<u8> {
    let mut output = Vec::with_capacity(data.len() + 6 + (data.len() / MAX_DEFLATE_STORED_BLOCK) * 5);
    output.extend_from_slice(&ZLIB_NO_COMPRESSION);

    let mut remaining = data;
    while !remaining.is_empty() {
        let len = remaining.len().min(MAX_DEFLATE_STORED_BLOCK);
        let final_block = len == remaining.len();
        output.push(if final_block { 0x01 } else { 0x00 });
        let len_u16 = len as u16;
        output.extend_from_slice(&len_u16.to_le_bytes());
        output.extend_from_slice(&(!len_u16).to_le_bytes());
        output.extend_from_slice(&remaining[..len]);
        remaining = &remaining[len..];
    }

    if data.is_empty() {
        output.push(0x01);
        output.extend_from_slice(&0_u16.to_le_bytes());
        output.extend_from_slice(&u16::MAX.to_le_bytes());
    }

    output.extend_from_slice(&adler32(data).to_be_bytes());
    output
}

fn adler32(data: &[u8]) -> u32 {
    const MOD_ADLER: u32 = 65_521;
    let mut a = 1_u32;
    let mut b = 0_u32;
    for byte in data {
        a = (a + u32::from(*byte)) % MOD_ADLER;
        b = (b + a) % MOD_ADLER;
    }
    (b << 16) | a
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xffff_ffff_u32;
    for byte in data {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            let mask = 0_u32.wrapping_sub(crc & 1);
            crc = (crc >> 1) ^ (0xedb8_8320 & mask);
        }
    }
    !crc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_png_signature_ihdr_idat_and_iend() {
        let mut bytes = Vec::new();
        let mut encoder = Encoder::new(&mut bytes, 1, 1);
        encoder.set_color(ColorType::Rgba);
        encoder.set_depth(BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(&[255, 0, 0, 255]).unwrap();
        drop(writer);

        assert_eq!(&bytes[..8], PNG_SIGNATURE);
        assert_eq!(&bytes[12..16], b"IHDR");
        assert!(bytes.windows(4).any(|window| window == b"IDAT"));
        assert_eq!(&bytes[bytes.len() - 12 + 4..bytes.len() - 12 + 8], b"IEND");
    }
}
