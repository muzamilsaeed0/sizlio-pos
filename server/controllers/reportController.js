const {
  getSummary,
  getSalesDetails,
  getTopItems,
  getPaymentSummary,
  getSalesChart
} = require('../models/reportModel');

function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\\d{4}-\\d{2}-\\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value;
}

function validateReportDateRange(req, res) {
  const { from, to } = req.query || {};
  if (from === undefined && to === undefined) return true;

  if (!isCalendarDate(from) || !isCalendarDate(to)) {
    res.status(400).json({
      success: false,
      code: 'INVALID_DATE_RANGE',
      message: 'Provide valid from and to dates in YYYY-MM-DD format.'
    });
    return false;
  }

  if (from > to) {
    res.status(400).json({
      success: false,
      code: 'INVALID_DATE_RANGE',
      message: 'The from date must be on or before the to date.'
    });
    return false;
  }

  return true;
}


// Manager Dashboard Summary
exports.summary = async (req, res) => {

  if (!['manager', 'counter'].includes(req.user.role)) {
    return res.status(403).json({
      success: false,
      message: 'Only manager or counter can view reports'
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
  if (!validateReportDateRange(req, res)) return;


  if(!['manager','counter'].includes(req.user.role)){
    return res.status(403).json({
      success:false,
      message:'Only manager or counter can view sales'
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
  if (!validateReportDateRange(req, res)) return;



  if(!['manager','counter'].includes(req.user.role)){

    return res.status(403).json({
      success:false,
      message:'Only manager or counter can view reports'
    });

  }


  try{


    const data = await getTopItems(
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
  if (!validateReportDateRange(req, res)) return;


  if(!['manager','counter'].includes(req.user.role)){

    return res.status(403).json({
      success:false,
      message:'Only manager or counter can view reports'
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
  if (!validateReportDateRange(req, res)) return;



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