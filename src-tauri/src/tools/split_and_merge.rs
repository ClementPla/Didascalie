use image::GrayImage;
use ndarray::Array3;

#[derive(Debug)]
enum QuadNode {
  Leaf {
    xmin: u32,
    ymin: u32,
    xmax: u32,
    ymax: u32,
  },
  Branch(Vec<QuadNode>),
}

fn region_contains_foreground(
  mask: &GrayImage,
  xmin: u32,
  ymin: u32,
  xmax: u32,
  ymax: u32
) -> bool {
  for y in ymin..ymax {
    for x in xmin..xmax {
      if mask.get_pixel(x, y).0[0] > 0 {
        return true;
      }
    }
  }
  false
}

fn split_region(
  mask: &GrayImage,
  xmin: u32,
  ymin: u32,
  xmax: u32,
  ymax: u32,
  max_depth: u32,
  min_size: u32
) -> Option<QuadNode> {
  // 1. Check if region has any foreground
  let has_fg = region_contains_foreground(mask, xmin, ymin, xmax, ymax);
  if !has_fg {
    return None; // discard if no foreground
  }

  let width = xmax - xmin;
  let height = ymax - ymin;

  // 2. If too small or no more depth allowed, return Leaf
  if max_depth == 0 || width <= min_size || height <= min_size {
    return Some(QuadNode::Leaf {
      xmin,
      ymin,
      xmax,
      ymax,
    });
  }

  // 3. Split into 4 quadrants
  let midx = xmin + width / 2;
  let midy = ymin + height / 2;

  let c1 = split_region(mask, xmin, ymin, midx, midy, max_depth - 1, min_size);
  let c2 = split_region(mask, midx, ymin, xmax, midy, max_depth - 1, min_size);
  let c3 = split_region(mask, xmin, midy, midx, ymax, max_depth - 1, min_size);
  let c4 = split_region(mask, midx, midy, xmax, ymax, max_depth - 1, min_size);

  // 4. Collect children
  let mut children = Vec::new();
  for c in [c1, c2, c3, c4] {
    if let Some(node) = c {
      children.push(node);
    }
  }

  if children.is_empty() {
    None
  } else if children.len() == 1 {
    // Only one child => bubble it up
    Some(children.into_iter().next().unwrap())
  } else {
    // Multiple => branch
    Some(QuadNode::Branch(children))
  }
}

fn merge_quadnode(node: QuadNode) -> QuadNode {
  match node {
    QuadNode::Branch(children) => {
      // Recursively merge children first
      let merged_children: Vec<QuadNode> = children.into_iter().map(merge_quadnode).collect();

      // If all children are leaves and form a perfect rectangle, attempt merge
      if let Some(leaf) = try_merge_leaves(&merged_children) {
        QuadNode::Leaf {
          xmin: leaf[0],
          ymin: leaf[1],
          xmax: leaf[2],
          ymax: leaf[3],
        }
      } else {
        QuadNode::Branch(merged_children)
      }
    }
    leaf @ QuadNode::Leaf { .. } => leaf,
  }
}

fn try_merge_leaves(children: &[QuadNode]) -> Option<[u32; 4]> {
  // Gather bounding boxes
  let mut leaves = vec![];
  for child in children {
    if let QuadNode::Leaf { xmin, ymin, xmax, ymax } = child {
      leaves.push([*xmin, *ymin, *xmax, *ymax]);
    } else {
      // If any child is a Branch, we can't do a full merge
      return None;
    }
  }
  let all_xmin = leaves
    .iter()
    .map(|l| l[0])
    .min()?;
  let all_ymin = leaves
    .iter()
    .map(|l| l[1])
    .min()?;
  let all_xmax = leaves
    .iter()
    .map(|l| l[2])
    .max()?;
  let all_ymax = leaves
    .iter()
    .map(|l| l[3])
    .max()?;

  // 1) The big bounding rectangle
  let width = all_xmax - all_xmin;
  let height = all_ymax - all_ymin;
  let bounding_area = (width as u64) * (height as u64);

  // 2) Sum the children’s areas
  let mut sum_area = 0u64;
  for [xmin, ymin, xmax, ymax] in &leaves {
    let w = xmax - xmin;
    let h = ymax - ymin;
    sum_area += (w as u64) * (h as u64);
  }

  // 3) Check if the children exactly fill that bounding rect with no overlap
  // You might need an additional “overlap check” if you fear children might overlap.
  if sum_area == bounding_area {
    // Perfect tiling => merge
    Some([all_xmin, all_ymin, all_xmax, all_ymax])
  } else {
    // Otherwise, don’t merge
    None
  }
}

fn collect_leaves(node: &QuadNode, out: &mut Vec<[u32; 4]>) {
  match node {
    QuadNode::Leaf { xmin, ymin, xmax, ymax } => {
      out.push([*xmin, *ymin, *xmax, *ymax]);
    }
    QuadNode::Branch(children) => {
      for c in children {
        collect_leaves(c, out);
      }
    }
  }
}

pub fn quadtree_bounding_boxes(mask: &GrayImage, max_depth: u32, min_size: u32) -> Vec<[u32; 4]> {
  // 1. Convert to grayscale

  // 2. Build quadtree over entire image
  let width: u32 = mask.width();
  let height: u32 = mask.height();

  

  // 2.5 The initial region is the bounding box of the mask

  let mut xmin = width;
  let mut ymin = height;
  let mut xmax = 0;
  let mut ymax = 0;
  for y in 0..height {
    for x in 0..width {
      if mask.get_pixel(x, y).0[0] > 0 {
        xmin = xmin.min(x);
        ymin = ymin.min(y);
        xmax = xmax.max(x);
        ymax = ymax.max(y);
      }
    }
  }

  let root: Option<QuadNode> = split_region(&mask, xmin, ymin, xmax, ymax, max_depth, min_size);

  // If there's no foreground, return empty
  let root: QuadNode = match root {
    Some(node) => node,
    None => {
      return Vec::new();
    }
  };
  // 3. Optionally merge
  let merged = merge_quadnode(root);

  // 4. Collect leaves
  let mut boxes: Vec<[u32; 4]> = Vec::new();
  collect_leaves(&merged, &mut boxes);
  println!("Found {} bounding boxes", boxes.len());
  let boxes = reduce_bbox_to_fit_mask_content(&mask, &boxes);
  println!("Reduced to {} bounding boxes", boxes.len());
  boxes
}

fn reduce_bbox_to_fit_mask_content(mask: &GrayImage, boxes: &Vec<[u32; 4]>) -> Vec<[u32; 4]> {
  /*
  For each bounding box:
  We find the xmin/xmax; ymin/ymax of the mask content within the box.
  We then update the bounding box to fit the content.
   */
  let mut output: Vec<[u32; 4]> = Vec::new();
  for b in boxes {
    let mut xmin = mask.width();
    let mut ymin = mask.height();
    let mut xmax = 0;
    let mut ymax = 0;
    let mut total_pixels = 0;
    for y in b[1]..b[3] {
      for x in b[0]..b[2] {
        if mask.get_pixel(x, y).0[0] > 0 {
          xmin = xmin.min(x);
          ymin = ymin.min(y);
          xmax = xmax.max(x);
          ymax = ymax.max(y);
          total_pixels += 1;
        }
      }
    }
    let bbox_area = (b[2] - b[0]) * (b[3] - b[1]);
    let offsetx = 0;
    let offsety = 0; 
    let ratio = total_pixels as f32 / bbox_area as f32;
    if ratio >= 0.5 {
      output.push([xmin - offsetx, ymin - offsety, xmax + offsetx, ymax + offsetx]);
    }
  }
  if output.len() == 0 {
    return boxes.clone();
  };
  output
}

pub fn format_bounding_boxes(boxes: &Vec<[u32; 4]>) -> Array3<f32> {
  // 5. Put results into Array3 of shape (N, 1, 4)
  let n = boxes.len();
  let mut arr: ndarray::ArrayBase<
    ndarray::OwnedRepr<f32>,
    ndarray::Dim<[usize; 3]>
  > = Array3::zeros((n, 1, 4));
  for (i, b) in boxes.iter().enumerate() {
    arr[[i, 0, 0]] = b[0] as f32;
    arr[[i, 0, 1]] = b[1] as f32;
    arr[[i, 0, 2]] = b[2] as f32;
    arr[[i, 0, 3]] = b[3] as f32;
  }
  arr
}
