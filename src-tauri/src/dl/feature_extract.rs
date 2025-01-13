use image::GenericImageView;
use ndarray::{ Array4, Array3 };
use ort::{
  memory::Allocator, value::{Tensor, Value}

};

use crate::tools;

pub struct FeaturesExtractor {
  expected_size: u32,
  pub features: Value,
}

impl FeaturesExtractor {
  pub fn new() -> Self {

    FeaturesExtractor {
      expected_size: 1024,
      features: Tensor::<f32>::new(&Allocator::default(), [1, 256, 64, 64]).unwrap().into_dyn(),
    }
  }
  pub fn prepare_image(&self, input_blob: Vec<u8>, width: usize, height: usize) -> Tensor<f32> {
    let image = self.load_blob_to_image(input_blob, width, height);
    println!("Image size: {:?}", image.dimensions());
    let image = image.resize_exact(
      self.expected_size,
      self.expected_size,
      image::imageops::FilterType::Nearest
    );
    let mut image_array = Array4::<f32>::zeros([
      1,
      3,
      self.expected_size as usize,
      self.expected_size as usize,
    ]);

    for (x, y, pixel) in image.pixels() {
      for c in 0..3 {
        image_array[[0, c, y as usize, x as usize]] = (pixel[c] as f32) / 255.0;
      }
    }

    Tensor::from_array(image_array).unwrap()
  }

  fn load_blob_to_image(&self, blob: Vec<u8>, width: usize, height: usize) -> image::DynamicImage {
    // Vec<8> is a list of RGB values. Format is [R, G, B, ...]
    image::DynamicImage::ImageRgba8(
      image::RgbaImage::from_raw(width as u32, height as u32, blob).unwrap()
    )
  }

  pub fn extract_features(
    &mut self,
    image: Tensor<f32>,
    session: &ort::session::Session
  ) -> Result<(), Box<dyn std::error::Error>> {
    println!("Running encoder inference");
    let mut io_binding = session.create_binding().unwrap();
    io_binding.bind_input("image", &image)?;
    io_binding.bind_output_to_device("features", &session.allocator().memory_info())?;

    self.features = io_binding.run().unwrap().remove("features").unwrap();
    Ok(())
    
  }
  pub fn get_features(&self) -> &Value {
    &self.features
  }

  pub fn extract_bbox_and_color_from_mask(
    &self,
    mask: Vec<u8>,
    width: usize,
    height: usize,
    max_depth: u32,
    min_size: u32
  ) -> (Array3<f32>, [u8; 4]) {
    let mask: image::DynamicImage = image::DynamicImage::ImageRgba8(
      image::RgbaImage::from_raw(width as u32, height as u32, mask).unwrap()
    );
    let mask: image::DynamicImage = mask.resize_exact(
      256,
      256,
      image::imageops::FilterType::Nearest
    );
    let mask_pixels: Vec<_> = mask.pixels().collect();
    // Find the first pixel with a non-zero value and use it as the color
    let color = mask_pixels
      .iter()
      .find_map(|(_, _, pixel)| {
        if pixel[0] > 0 { Some([pixel[0], pixel[1], pixel[2], pixel[3]]) } else { None }
      })
      .unwrap_or([0, 0, 0, 0]);

    let graymask: image::ImageBuffer<image::Luma<u8>, Vec<u8>> = mask.to_luma8();

    let mut boxes = tools::split_and_merge::quadtree_bounding_boxes(&graymask, max_depth, min_size);
    // Resize coordinates from 256x256 to expected_size x expected_size
    
    for bbox in boxes.iter_mut() {
      bbox[0] = (bbox[0] as f32 / 256.0 * self.expected_size as f32) as u32;
      bbox[1] = (bbox[1] as f32 / 256.0 * self.expected_size as f32) as u32;
      bbox[2] = (bbox[2] as f32 / 256.0 * self.expected_size as f32) as u32;
      bbox[3] = (bbox[3] as f32 / 256.0 * self.expected_size as f32) as u32;
    }

    let bbox_array = tools::split_and_merge::format_bounding_boxes(&boxes);

    println!("Bbox array shape: {:?}", bbox_array.shape());
    (bbox_array, color)
  }
}
