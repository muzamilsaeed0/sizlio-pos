const {
  getSummary,
  getSalesDetails,
  getTopItems,
  getPaymentSummary,
  getSalesChart
} = require('../models/reportModel');


// Manager Dashboard Summary
exports.summary = async (req, res) => {

  if (req.user.role !== 'manager') {
    return res.status(403).json({
      success: false,
      message: 'Only manager can view reports'
    });
  }

  try {

    const data = await getSummary(
      req.user.restaurant_id
    );

    res.json({
      success: true,
      data
    });

  } catch (err) {

    console.error('Summary error:', err);

    res.status(500).json({
      success:false,
      message:'Server error'
    });

  }

};



// Sales Details
exports.salesDetails = async (req,res)=>{

  if(req.user.role !== 'manager'){
    return res.status(403).json({
      success:false,
      message:'Only manager can view sales'
    });
  }


  try{

    const data = await getSalesDetails(
      req.user.restaurant_id,
      req.query.from,
      req.query.to
    );


    res.json({
      success:true,
      data
    });


  }catch(err){

    console.error(
      "Sales Details Error:",
      err
    );

    res.status(500).json({
      success:false,
      message:'Server error'
    });

  }

};



// Top Selling Items
exports.topItems = async (req,res)=>{


  if(req.user.role !== 'manager'){

    return res.status(403).json({
      success:false,
      message:'Only manager can view reports'
    });

  }


  try{


    const data = await getTopItems(
      req.user.restaurant_id
    );


    res.json({
      success:true,
      data
    });


  }catch(err){


    console.error(
      "Top Items Error:",
      err
    );


    res.status(500).json({
      success:false,
      message:'Server error'
    });


  }

};



// Payment Summary
exports.paymentSummary = async (req,res)=>{

  if(req.user.role !== 'manager'){

    return res.status(403).json({
      success:false,
      message:'Only manager can view reports'
    });

  }


  try{


 const data = await getPaymentSummary(
  req.user.restaurant_id,
  req.query.from,
  req.query.to
);


    res.json({
      success:true,
      data
    });


  }catch(err){


    console.error(
      "Payment Summary Error:",
      err
    );


    res.status(500).json({
      success:false,
      message:'Server error'
    });


  }

};



exports.salesChart = async(req,res)=>{


try{


const {from,to}=req.query;


const data =
await getSalesChart(
req.user.restaurant_id,
from,
to
);


res.json({

success:true,
data

});


}
catch(err){

console.log(err);

res.status(500).json({

success:false,
message:'Server error'

});

}

};